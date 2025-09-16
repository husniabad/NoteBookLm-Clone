from pydantic import BaseModel
from typing import List, Tuple, Union
from bs4 import BeautifulSoup

class Span(BaseModel):
    text: str
    font: str
    size: float
    color: str
    is_bold: bool
    is_italic: bool
    is_line_end: bool = False

class TextBlock(BaseModel):
    type: str = "text"
    bounding_box: Tuple[float, float, float, float]
    spans: List[Span]
    
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

class PageData(BaseModel):
    page_number: int
    page_dimensions: PageDimensions
    content_blocks: List[Union[TextBlock, ImageBlock, HeaderFooterTextBlock, OcrTextBlock, VectorBlock]]
    combined_markdown: str

def generate_combined_markdown(content_blocks: List[Union[TextBlock, ImageBlock]]) -> str:
    """Generates a clean markdown string from the structured content blocks."""
    markdown_parts = []
    for block in content_blocks:
        if block.type == "header_footer_text":
            markdown_parts.append(block.content)
        elif block.type == "text":
            text_content = "".join(span.text for span in block.spans)
            markdown_parts.append(text_content)
        elif block.type == "ocr_text_block":
            soup = BeautifulSoup(block.html_content, 'html.parser')
            markdown_parts.append(soup.get_text())
        elif block.type == "image":
            caption = block.caption or "Untitled Image"
            markdown_parts.append(f"{caption}\n\nVisual Description: {block.description}")
        elif block.type == "vector":
            markdown_parts.append(f"Untitled Vector\n\nVisual Description: {block.description}")
    return "\n\n".join(markdown_parts)

def create_text_block(block_data: dict) -> TextBlock:
    """Create a TextBlock from extracted data"""
    return TextBlock(
        bounding_box=block_data['bounding_box'],
        spans=block_data['spans']
    )

def create_image_block(metadata: dict, ai_analysis: dict, image_url: str) -> ImageBlock:
    """Create an ImageBlock from metadata and AI analysis"""
    return ImageBlock(
        bounding_box=metadata['image_bbox'],
        url=image_url,
        visual_id=metadata['visual_id'],
        caption=metadata['caption'],
        description=ai_analysis.get("description", ""),
        content_type=ai_analysis.get("contentType", "unknown"),
        raw_text=ai_analysis.get("rawText"),
        width=metadata['width'],
        height=metadata['height']
    )

def create_ocr_text_block(image_bbox, harvested_text: str, image_url: str) -> OcrTextBlock:
    """Create an OcrTextBlock from OCR results"""
    return OcrTextBlock(
        bounding_box=image_bbox,
        html_content=f"<p>{harvested_text}</p>",
        source_image_url=image_url
    )

def create_header_footer_block(image_bbox, content: str) -> HeaderFooterTextBlock:
    """Create a HeaderFooterTextBlock from extracted content"""
    return HeaderFooterTextBlock(
        bounding_box=image_bbox,
        content=content
    )

def sort_content_blocks(content_blocks: List) -> List:
    """Sort all blocks by reading order (top-to-bottom, left-to-right)"""
    return sorted(content_blocks, key=lambda b: (b.bounding_box[1], b.bounding_box[0]))

def build_page_data(page_num: int, page, content_blocks: List) -> dict:
    """Build final PageData structure as dict"""
    sorted_blocks = sort_content_blocks(content_blocks)
    combined_markdown = generate_combined_markdown(sorted_blocks)
    
    return {
        "page_number": page_num + 1,
        "page_dimensions": {"width": page.rect.width, "height": page.rect.height},
        "content_blocks": [block.dict() for block in sorted_blocks],
        "combined_markdown": combined_markdown
    }