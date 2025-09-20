import fitz
import re
import pdfplumber
from typing import List, Dict, Tuple, Any

def extract_tables_from_page(pdf_path: str, page_num: int) -> List[Tuple[List[List[str | None]], Tuple[float, float, float, float], float]]:
    """Extract tables from a specific page of a PDF using pdfplumber, including average font size."""
    tables_with_coords_and_font = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            page = pdf.pages[page_num - 1]
            found_tables = page.find_tables()
            
            all_chars = page.chars

            for table in found_tables:
                table_data = table.extract()
                bbox = table.bbox  # (x0, top, x1, bottom)
                
                # Find average font size of text within the table bbox
                x0, y0, x1, y1 = bbox
                table_chars = [
                    char for char in all_chars
                    if char['x0'] >= x0 and char['x1'] <= x1 and
                       char['top'] >= y0 and char['bottom'] <= y1
                ]
                
                if table_chars:
                    avg_font_size = sum(c['size'] for c in table_chars) / len(table_chars)
                else:
                    avg_font_size = 8.0 # A default fallback

                tables_with_coords_and_font.append((table_data, bbox, avg_font_size))
    except Exception as e:
        print(f"Could not extract tables from page {page_num} using pdfplumber: {e}")
    return tables_with_coords_and_font

def get_closest_caption(image_bbox: fitz.Rect, potential_captions: List[Dict]) -> str | None:
    """
    Finds the closest text block that matches a caption pattern for a given image.
    Prioritizes captions located directly below the image.
    """
    closest_caption_text = None
    min_distance = float('inf')

    for block in potential_captions:
        caption_bbox = fitz.Rect(block['bbox'])
        
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

def extract_text_blocks(page_dict: Dict, table_areas: List[Tuple[float, float, float, float]], image_areas: List[Tuple[float, float, float, float]]) -> List[Dict]:
    """Extract text blocks, excluding any that fall within table or image areas."""
    content_blocks = []

    for block in page_dict.get("blocks", []):
        if block['type'] == 0:  # Text block
            block_bbox = fitz.Rect(block['bbox'])
            in_table = any(block_bbox.intersects(fitz.Rect(area)) for area in table_areas)
            in_image = any(fitz.Rect(area).contains(block_bbox) for area in image_areas)

            if not in_table and not in_image:
                spans_data = []
                for line_idx, line in enumerate(block.get("lines", [])):
                    for span_idx, span in enumerate(line.get("spans", [])):
                        flags = span['flags']
                        spans_data.append({
                            'text': span['text'],
                            'font': span['font'],
                            'size': span['size'],
                            'color': '#%06x' % span['color'],
                            'is_bold': bool(flags & 2**4),
                            'is_italic': bool(flags & 2**1),
                            'is_line_end': span_idx == len(line.get("spans", [])) - 1
                        })
                
                content_blocks.append({
                    'type': 'text',
                    'bounding_box': block['bbox'],
                    'spans': spans_data
                })
    
    return content_blocks

def identify_potential_captions(page_dict: Dict) -> List[Dict]:
    """Identify potential caption blocks using regex patterns"""
    caption_pattern = re.compile(r'^\s*(fig|figure|table|chart)\.?\s*[\w\.]+|^\s*\(\w\)', re.IGNORECASE)
    potential_captions = []
    all_text_blocks = [b for b in page_dict.get("blocks", []) if b.get('type') == 0]
    
    for block in all_text_blocks:
        block_text = " ".join(
            span['text'] 
            for line in block.get('lines', []) 
            for span in line.get('spans', [])
        ).strip()
        
        if caption_pattern.match(block_text):
            potential_captions.append(block)
    
    return potential_captions

def extract_images_from_page(page: fitz.Page, pdf_document: fitz.Document) -> List[Tuple]:
    """Extract images from a PDF page with metadata"""
    images = page.get_images(full=True)
    image_data = []
    
    for i, img in enumerate(images):
        xref = img[0]
        base_image = pdf_document.extract_image(xref)
        image_bytes, width, height = base_image["image"], base_image["width"], base_image["height"]
        image_bbox = page.get_image_bbox(img)
        
        image_data.append({
            'index': i,
            'image_bytes': image_bytes,
            'width': width,
            'height': height,
            'bbox': image_bbox,
            'xref': xref
        })
    
    return image_data