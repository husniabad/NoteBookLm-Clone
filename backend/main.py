import os
import fitz  # PyMuPDF
import aiohttp
import asyncio
import base64
import json
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple
from dotenv import load_dotenv
import math
from pathlib import Path
from PIL import Image
import io
import imagehash
import hashlib
import pytesseract
import re


# Load environment variables from .env file
load_dotenv()
known_background_hashes = set()
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'


# --- Configuration ---
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY") 
VISION_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key={GEMINI_API_KEY}"
# This is a placeholder; your actual blob upload URL might be different
BLOB_UPLOAD_URL = os.getenv("BLOB_STORAGE_UPLOAD_URL") 
UPLOADS_DIR= Path("uploads")

# --- STEP 1: UPDATED PYDANTIC MODELS FOR BLUEPRINT ---

class Style(BaseModel):
    font_name: str
    font_size: int
    color: str

class TextBlock(BaseModel):
    type: str = "text"
    bounding_box: Tuple[float, float, float, float]
    html_content: str
    
class ImageBlock(BaseModel):
    type: str = "image"
    bounding_box: Tuple[float, float, float, float]
    url: str
    visual_id: str
    caption: str | None = None
    description: str
    content_type: str
    raw_text: str | None = None
    width: int
    height: int

class PageDimensions(BaseModel):
    width: float
    height: float


class HeaderFooterTextBlock(BaseModel):
    type: str = "header_footer_text"
    bounding_box: Tuple[float, float, float, float]
    content: str

class OcrTextBlock(BaseModel):
    type: str = "ocr_text_block"
    bounding_box: Tuple[float, float, float, float]
    html_content: str
    source_image_url: str

class VectorBlock(BaseModel):
    type: str = "vector"
    bounding_box: Tuple[float, float, float, float]
    url: str  # URL to the saved SVG file
    visual_id: str
    description: str
    content_type: str
    # ... any other relevant metadata

class PageData(BaseModel):
    page_number: int
    page_dimensions: PageDimensions
    content_blocks: List[TextBlock | ImageBlock | HeaderFooterTextBlock | OcrTextBlock | VectorBlock]
    combined_markdown: str




# --- FastAPI App Initialization ---
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Helper Functions ---

def classify_image(
    image_bytes: bytes, width: int, height: int,
     page_width: float, page_height: float,
    seen_hashes: set, junk_hashes: set
) ->Tuple[str, str | None]:
    """
    Classifies an image using a corrected repetition check based on its visual hash.
    """
    try:
        img_hash = hashlib.sha256(image_bytes).hexdigest()

        # 1. First, check if this hash is already confirmed junk.
        if img_hash in junk_hashes:
            print("Image is junk.")
            return ('background', None)
        
        # 2. Second, check if we've seen this hash before. , the first one could escape; we handle it partially next
        if img_hash in seen_hashes:
            junk_hashes.add(img_hash)
            try:
                harvested_text = pytesseract.image_to_string(Image.open(io.BytesIO(image_bytes))).strip()
                print("Image is a known background.")
                return ('background', harvested_text if harvested_text else None)
            except Exception:
                print("Error processing known background image.")
                return ('background', None)
        # 3. If it's not junk and we haven't seen it, record it.
        seen_hashes.add(img_hash)

    except Exception as e:
        print(f"Image hashing error: {e}")

    # Heuristic and Content Checks for First-Time Images
    if len(image_bytes) < 3072 or (width < 50 and height < 50):
        print("the image too small in file size or dimensions.")
        return ('background', None)
    # Filter for extreme aspect ratios (lines/borders)
    if width > 0 and height > 0:
        aspect_ratio = width / height
        if aspect_ratio > 20 or aspect_ratio < 0.05:
            print("Image has extreme aspect ratio.")
            return ('unwanted', None)
    
    #NOTE needs to be fixed as it does not identify pdfs full page image based
    # # If the image's dimensions are very close to the page's dimensions,
    # # it's almost certainly a full-page background.
    # width_ratio = width / page_width
    # height_ratio = height / page_height
    # if width_ratio > 0.95 and height_ratio > 0.95:
    #     # It's a background. Harvest any text and discard the image.
    #     image = Image.open(io.BytesIO(image_bytes))
    #     harvested_text = pytesseract.image_to_string(image).strip()
    #     print("Image is a full-page background.")
    #     return ('background', harvested_text if harvested_text else None)
    

    try:
        # 3. OCR Confidence Check for text-heavy images
        ocr_text = pytesseract.image_to_string(Image.open(io.BytesIO(image_bytes))).strip()
        if len(ocr_text) > 100:
             print("Image is text-heavy, using OCR.")
             return ('ocr', ocr_text)

    except Exception as e:
        print(f"Content analysis/OCR error: {e}")
        return ('vision', None)
    
    return ('vision', None)



#####
async def save_to_local(image_bytes: bytes, filename: str) -> str:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    file_path = UPLOADS_DIR / filename
    with open(file_path, "wb") as f: f.write(image_bytes)
    return str(file_path)

    
"""
async def upload_to_blob(session: aiohttp.ClientSession, image_bytes: bytes, filename: str) -> str:
    # This is a placeholder. Your actual blob storage implementation may differ.
    # For Vercel Blob, you'd typically make a POST request with the file.
    # For now, we'll just return a placeholder URL.
    # async with session.post(BLOB_UPLOAD_URL, data={'file': image_bytes}) as response:
    #     if response.status == 200:
    #         data = await response.json()
    #         return data.get('url')
    #     else:
    #         return "http://example.com/placeholder.png" # Return a placeholder on failure
    return f"https://your-blob-storage.com/{filename}"

"""

def resize_image_for_ai(image_bytes: bytes, img_width: int, img_height: int, page_width: float, page_height: float) -> bytes:
    """
    Dynamically resizes an image using a linear formula based on its page coverage.
    """
    try:
        # Define the target size range
        min_target_size = 400
        max_target_size = 800

        # Calculate the image's area as a percentage of the page's area
        image_area = img_width * img_height
        page_area = page_width * page_height if page_height > 0 else 0
        coverage_ratio = image_area / page_area if page_area > 0 else 0

        # Apply the formula to calculate the dynamic max_size
        max_size = int(min_target_size + (max_target_size - min_target_size) * coverage_ratio)

        image = Image.open(io.BytesIO(image_bytes))
        print(f"Original image size: {image.width}x{image.height}")
        
        if image.width > max_size or image.height > max_size:
            image.thumbnail((max_size, max_size))
            print(f"Resized image to: {image.width}x{image.height}")
            output_buffer = io.BytesIO()
            image.save(output_buffer, format="PNG")
            return output_buffer.getvalue()

    except Exception as e:
        print(f"Error resizing image: {e}")
        return image_bytes
        
    return image_bytes

# --- STEP 3: ENRICHED AI VISION ANALYSIS ---
async def get_ai_visual_analysis(session: aiohttp.ClientSession, image_bytes: bytes) -> Dict[str, Any]:
    """Gets a structured JSON analysis of an image from the AI Vision Model."""
    headers = {"Content-Type": "application/json"}
    prompt = """First, classify this image's content. Is it "substantive" (a photograph, chart, or complex diagram) or "decorative" (a simple icon, logo, border, or line)?
    
Then, based on your classification, return a single JSON object with the following keys:
- "contentType": Your classification ("substantive" or "decorative").
- "description": If "substantive", provide a detailed analysis. If "decorative", provide a brief one-sentence description (e.g., "A logo for a company.").
- "rawText": Extract any visible text from the image.

Example for a substantive image: {"contentType": "substantive", "description": "A bar chart showing Q3 sales growth.", "rawText": "Q3 Sales"}
Example for a decorative image: {"contentType": "decorative", "description": "A boat icon.", "rawText": ""}
"""
    payload = {
        "contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(image_bytes).decode()}}]}],
        "generationConfig": {"responseMimeType": "application/json"}
    }
    
    async with session.post(VISION_API_URL, json=payload, headers=headers) as response:
        if response.status == 200:
            data = await response.json()
            try:
                # The response is now expected to be a JSON string
                json_text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "{}")
                return json.loads(json_text)
            except (json.JSONDecodeError, IndexError):
                return {"description": "AI analysis failed to return valid JSON.", "contentType": "error", "rawText": ""}
        else:
            error_text = await response.text()
            # print(f"Error from Vision API: {error_text}")
            # print(f"Vision API is disabled for debugging purposes.")
            return {"description": f"Error: API request failed with status {response.status}", "contentType": "error", "rawText": ""}

def get_closest_caption(image_bbox: fitz.Rect, potential_captions: List[Dict]) -> str | None:
    """
    Finds the closest text block that matches a caption pattern for a given image.
    Prioritizes captions located directly below the image.
    """
    closest_caption_text = None
    min_distance = float('inf')

    for block in potential_captions:
        caption_bbox = fitz.Rect(block['bbox'])
        
        # --- THE FIX: Look for captions BELOW the image ---
        # The caption's top (y0) must be greater than the image's bottom (y1).
        if caption_bbox.y0 > image_bbox.y1:
            
            # Calculate vertical distance from image bottom to caption top
            distance = caption_bbox.y0 - image_bbox.y1
            
            # Find the closest one that is reasonably near
            if 0 <= distance < min_distance and distance < 50: # 50 points threshold
                min_distance = distance
                caption_text = " ".join(
                    span['text'] 
                    for line in block.get('lines', []) 
                    for span in line.get('spans', [])
                ).strip()
                closest_caption_text = caption_text
                
    return closest_caption_text


# --- STEP 2: STRUCTURED MARKDOWN GENERATION ---
def generate_combined_markdown(content_blocks: List[TextBlock | ImageBlock]) -> str:
    """Generates a clean markdown string from the structured content blocks."""
    markdown_parts = []
    for block in content_blocks:
        if block.type == "text":
            # A more sophisticated version would convert HTML to Markdown here
            # For now, we extract text from HTML for simplicity
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(block.html_content, 'html.parser')
            markdown_parts.append(soup.get_text())
        elif block.type == "image":
            caption = block.caption or "Untitled Image"
            md_image = f"![{caption}]({block.url})\n\n**Visual Description:** {block.description}"
            markdown_parts.append(md_image)
    return "\n\n".join(markdown_parts)

# --- Main API Endpoint ---
@app.post("/process-pdf/")
async def process_pdf(file: UploadFile = File(...)):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=500, detail="AI API key is not configured.")
        
    seen_hashes = set()
    junk_hashes = set()
    final_data: List[PageData] = []
    file_bytes = await file.read()
    pdf_document = fitz.open(stream=file_bytes, filetype="pdf")
    
    async with aiohttp.ClientSession() as session:
        for page_num in range(len(pdf_document)):
            page = pdf_document.load_page(page_num)
            

            # --- STEP 1: FULL BLUEPRINT EXTRACTION ---
            page_dict = page.get_text("dict")
            content_blocks = []
            all_text_blocks = [b for b in page_dict.get("blocks", []) if b.get('type') == 0]


            # Identify potential caption blocks using regex
            caption_pattern = re.compile(r'^\s*(fig|figure|table|chart)\.?\s*[\w\.]+|^\s*\(\w\)', re.IGNORECASE)            
            potential_captions = []
            for block in all_text_blocks:
                # Combine all text in the block to check against the pattern
                block_text = " ".join(
                    span['text'] 
                    for line in block.get('lines', []) 
                    for span in line.get('spans', [])
                ).strip()
                
                if caption_pattern.match(block_text):
                    potential_captions.append(block)
            
            # Extract text blocks with HTML styling
            for block in page_dict.get("blocks", []):
                if block['type'] == 0: # Text block
                    html_content = ""
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            font_size = span['size']
                            font_name = span['font']
                            color = '#%06x' % span['color']
                            text = span['text']
                            
                            style = f"font-family:'{font_name}'; font-size:{font_size}px; color:{color};"
                            # A simple HTML conversion
                            html_content += f"<span style='{style}'>{text}</span>"
                        html_content += "<br>"
                    
                    content_blocks.append(TextBlock(
                        bounding_box=block['bbox'],
                        html_content=f"<div>{html_content}</div>"
                    ))

            # Extract image blocks and trigger AI analysis
            images = page.get_images(full=True)
            for i, img in enumerate(images):
                xref = img[0]
                base_image = pdf_document.extract_image(xref)
                image_bytes, width, height = base_image["image"], base_image["width"], base_image["height"]
                image_bbox = page.get_image_bbox(img)
                visual_id = f"page_{page_num + 1}_img_{i}"
                caption = get_closest_caption(image_bbox, potential_captions)
                print(f"Processing image {i } on page {page_num + 1}: {caption}")

                # Classify the image to decide the processing path
                page_width, page_height = page.rect.width, page.rect.height
                classification, harvested_text = classify_image(
                    image_bytes, width, height,
                    page_width, page_height,
                    seen_hashes, junk_hashes
                )

                image_url = await save_to_local(image_bytes, f"{visual_id}.png")
                if classification == 'unwanted':
                    # print(f"Detected unwanted image on page {page_num + 1}. Skipping.")
                    continue

                if classification == 'background':
                    # print(f"Detected background on page {page_num + 1}. Harvesting text.")
                    if harvested_text:
                        content_blocks.append(HeaderFooterTextBlock(
                            bounding_box=image_bbox,
                            content=harvested_text
                        ))
                    continue # Skip further processing for this image

                elif classification == 'ocr':
                    print(f"Detected text-heavy image on page {page_num + 1}. Using OCR.")
                    # image_url = await save_to_local(image_bytes, f"{visual_id}.png")
                    content_blocks.append(OcrTextBlock(
                        bounding_box=image_bbox,
                        html_content=f"<p>{harvested_text}</p>",
                        source_image_url=image_url
                    ))
                    continue # Skip the vision model

                # If classification is 'vision', proceed with the full AI analysis
                print(f"Detected complex visual on page {page_num + 1}. Using Vision AI.")
                resized_image_bytes = resize_image_for_ai(image_bytes, width, height, page_width, page_height)

                ai_analysis = await get_ai_visual_analysis(session, resized_image_bytes)

                image_url = await save_to_local(image_bytes, f"{visual_id}.png")
                if ai_analysis.get("contentType") == 'decorative':
                    print(f"AI classified image as decorative on page {page_num + 1}.")
                    
                    # Harvest the text and create a simple block
                    harvested_text = ai_analysis.get("rawText")
                    if harvested_text:
                        content_blocks.append(HeaderFooterTextBlock(
                            bounding_box=image_bbox,
                            content=harvested_text
                        ))
                    continue # Discard the image and move to the next one
                

                content_blocks.append(ImageBlock(
                    bounding_box=image_bbox,
                    url=image_url,
                    visual_id=visual_id,
                    caption=caption,
                    description=ai_analysis.get("description", ""),
                    content_type=ai_analysis.get("contentType", "unknown"),
                    raw_text=ai_analysis.get("rawText"),
                    width=width,
                    height=height
                ))


            # drawings = page.get_drawings()
            # for i, drawing in enumerate(drawings):
            #     # Render the drawing area to a pixel map (image)
            #     pix = drawing.rect.to_pixmap(page.parent, alpha=True)
            #     image_bytes = pix.tobytes()
            #     width, height = pix.width, pix.height
                
            #     # Use the full classification logic
            #     classification, harvested_text = classify_image(
            #         image_bytes, width, height, seen_hashes, junk_hashes
            #     )

            #     if classification == 'background':
            #         if harvested_text:
            #             content_blocks.append(HeaderFooterTextBlock(
            #                 bounding_box=drawing.rect,
            #                 content=harvested_text
            #             ))
            #         continue

            #     elif classification == 'ocr':
            #         visual_id = f"page_{page_num + 1}_vector_{i}"
            #         image_url = await save_to_local(image_bytes, f"{visual_id}.png")
            #         content_blocks.append(OcrTextBlock(
            #             bounding_box=drawing.rect,
            #             html_content=f"<p>{harvested_text}</p>",
            #             source_image_url=image_url
            #         ))
            #         continue

            #     elif classification == 'vision':
            #         visual_id = f"page_{page_num + 1}_vector_{i}"
            #         image_url = await save_to_local(image_bytes, f"{visual_id}.png")
                    
            #         resized_bytes = resize_image_for_ai(image_bytes, width, height, page.rect.width, page.rect.height)
            #         ai_analysis = await get_ai_visual_analysis(session, resized_bytes)

            #         if ai_analysis.get("contentType") == 'decorative':
            #             if ai_analysis.get("rawText"):
            #                 content_blocks.append(HeaderFooterTextBlock(
            #                     bounding_box=drawing.rect,
            #                     content=ai_analysis.get("rawText")
            #                 ))
            #             continue
                        
            #         content_blocks.append(VectorBlock(
            #             bounding_box=drawing.rect,
            #             url=image_url,
            #             visual_id=visual_id,
            #             description=ai_analysis.get("description", ""),
            #             content_type=ai_analysis.get("contentType", "diagram")
            #         ))
                
                
            # Sort all blocks by reading order (top-to-bottom, left-to-right)
            content_blocks.sort(key=lambda b: (b.bounding_box[1], b.bounding_box[0]))

            # Generate the combined markdown from the final blueprint
            combined_markdown = generate_combined_markdown(content_blocks)

            final_data.append(PageData(
                page_number=page_num + 1,
                page_dimensions=PageDimensions(width=page.rect.width, height=page.rect.height),
                content_blocks=content_blocks,
                combined_markdown=combined_markdown
            ))
            
    return {"data": final_data}