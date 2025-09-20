import os
import fitz  # PyMuPDF
import aiohttp
import asyncio
import tempfile
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from typing import List
from dotenv import load_dotenv

# Import services
from image_classifier import classify_image, resize_image_for_ai
from ai_vision_service import get_ai_visual_analysis
from pdf_processor import get_closest_caption, extract_text_blocks, identify_potential_captions, extract_images_from_page, extract_tables_from_page
from content_builder import (
     create_text_block, create_image_block, create_table_block,
    create_ocr_text_block, create_header_footer_block, build_page_data
)
from aws_s3 import AWSS3

# Load environment variables
load_dotenv()

# Configuration
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY") 
VISION_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key={GOOGLE_API_KEY}"
# UPLOADS_DIR = Path("uploads")

# Storage Functions
# async def save_to_local(image_bytes: bytes, filename: str) -> str:
#     UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
#     file_path = UPLOADS_DIR / filename
#     with open(file_path, "wb") as f: 
#         f.write(image_bytes)
#     return str(file_path)

# Initialize AWS S3 client
s3_client = AWSS3(os.getenv('AWS_S3_BUCKET', 'your-bucket-name'))

async def upload_to_s3(session: aiohttp.ClientSession, file_bytes: bytes, filename: str, wait_for_response: bool = True) -> str | None:
    try:
        if wait_for_response:
            url = await s3_client.put(session, filename, file_bytes)
            print(f"Got URL for {filename}: {url}")
            return url
        else:
            # Fire and forget
            asyncio.create_task(s3_client.put(session, filename, file_bytes))
            print(f"File {filename} upload started")
            return None
    except Exception as e:
        print(f"Upload exception for {filename}: {e}")
        return "http://example.com/placeholder.png" if wait_for_response else None

# FastAPI App
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files for local image serving
# UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
# app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

@app.post("/process-pdf/")
async def process_pdf(file: UploadFile = File(...)):
    if not GOOGLE_API_KEY:
        raise HTTPException(status_code=500, detail="AI API key is not configured.")
        
    seen_hashes = set()
    junk_hashes = set()
    final_data: List[dict] = []
    file_bytes = await file.read()
    pdf_document = fitz.open(stream=file_bytes, filetype="pdf")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as temp_pdf:
        temp_pdf.write(file_bytes)
        temp_pdf_path = temp_pdf.name
    
    async with aiohttp.ClientSession() as session:
        # Start PDF upload in the background
        pdf_upload_task = asyncio.create_task(upload_to_s3(session, file_bytes, file.filename or "document.pdf"))

        # --- Phase 1: Collect all images and metadata from all pages ---
        all_image_metadata = []
        page_content_blocks = [[] for _ in range(len(pdf_document))]

        for page_num in range(len(pdf_document)):
            page = pdf_document.load_page(page_num)
            page_dict = page.get_text("dict")

            # --- MODIFICATION: Extract tables and their areas ---
            tables_with_coords_and_font = extract_tables_from_page(temp_pdf_path, page_num + 1)
            table_areas = [bbox for _, bbox, _ in tables_with_coords_and_font]
            
            for table_data, bbox, avg_font_size in tables_with_coords_and_font:
                page_content_blocks[page_num].append(create_table_block(table_data, bbox, avg_font_size))

            potential_captions = identify_potential_captions(page_dict)
            image_data = extract_images_from_page(page, pdf_document)
            image_areas = [img['bbox'] for img in image_data]

            text_blocks = extract_text_blocks(page_dict, table_areas, image_areas)
            page_content_blocks[page_num].extend([create_text_block(block_data) for block_data in text_blocks])
            
            for img_info in image_data:
                visual_id = f"page_{page_num + 1}_img_{img_info['index']}"
                page_width, page_height = page.rect.width, page.rect.height
                
                classification, harvested_text = classify_image(
                    img_info['image_bytes'], img_info['width'], img_info['height'],
                    page_width, page_height, seen_hashes, junk_hashes
                )

                if classification == 'unwanted':
                    continue
                if classification == 'background':
                    if harvested_text:
                        page_content_blocks[page_num].append(create_header_footer_block(img_info['bbox'], harvested_text))
                    continue

                # This image needs to be uploaded (either for OCR or Vision)
                all_image_metadata.append({
                    'page_num': page_num,
                    'visual_id': visual_id,
                    'classification': classification,
                    'img_info': img_info,
                    'harvested_text': harvested_text,
                    'caption': get_closest_caption(img_info['bbox'], potential_captions),
                })

        # --- Phase 2: Upload all collected images in parallel ---
        upload_tasks = [
            upload_to_s3(session, meta['img_info']['image_bytes'], f"{meta['visual_id']}.png")
            for meta in all_image_metadata
        ]
        print(f"Starting parallel upload of {len(upload_tasks)} images...")
        image_urls = await asyncio.gather(*upload_tasks)

        # Add URLs to metadata
        for i, url in enumerate(image_urls):
            all_image_metadata[i]['image_url'] = url

        # --- Phase 3: Create Vision AI tasks for substantive images ---
        vision_tasks = []
        vision_metadata = []
        for meta in all_image_metadata:
            if meta['classification'] == 'ocr':
                page_content_blocks[meta['page_num']].append(
                    create_ocr_text_block(meta['img_info']['bbox'], meta['harvested_text'], meta['image_url'])
                )
            else: # Assumes default is substantive/vision
                img_info = meta['img_info']
                page = pdf_document.load_page(meta['page_num'])
                page_width, page_height = page.rect.width, page.rect.height
                
                resized_image_bytes = resize_image_for_ai(
                    img_info['image_bytes'], img_info['width'], img_info['height'], page_width, page_height
                )
                vision_tasks.append(get_ai_visual_analysis(session, resized_image_bytes, VISION_API_URL))
                vision_metadata.append(meta)

        # --- Phase 4: Execute all Vision AI tasks in parallel ---
        print(f"Starting parallel processing of {len(vision_tasks)} vision tasks...")
        ai_results = await asyncio.gather(*vision_tasks)

        # --- Phase 5: Process AI results ---
        for i, ai_analysis in enumerate(ai_results):
            meta = vision_metadata[i]
            
            # Prepare metadata for block creation
            block_metadata = {
                'image_bbox': meta['img_info']['bbox'],
                'visual_id': meta['visual_id'],
                'caption': meta['caption'],
                'width': meta['img_info']['width'],
                'height': meta['img_info']['height']
            }

            if ai_analysis.get("contentType") == 'decorative':
                if ai_analysis.get("rawText"):
                    page_content_blocks[meta['page_num']].append(
                        create_header_footer_block(block_metadata['image_bbox'], ai_analysis.get("rawText"))
                    )
            else:
                page_content_blocks[meta['page_num']].append(
                    create_image_block(block_metadata, ai_analysis, meta['image_url'])
                )

        # --- Phase 6: Build final response ---
        for page_num in range(len(pdf_document)):
            page = pdf_document.load_page(page_num)
            final_page_data = build_page_data(page_num, page, page_content_blocks[page_num])
            final_data.append(final_page_data)
            
        pdf_url = await pdf_upload_task

    # Clean up the temporary file
    os.unlink(temp_pdf_path)
        
    return {"data": final_data, "pdf_url": pdf_url}
