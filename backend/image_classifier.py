import hashlib
import pytesseract
import numpy as np
from PIL import Image, ImageFilter
import io
import hashlib
from typing import Tuple
import os
import hashlib
import pytesseract
import numpy as np
from PIL import Image, ImageFilter
import io
from typing import Tuple

# Configure tesseract path
# In production (Linux VPS), Tesseract is usually in PATH.
# If not, set TESSERACT_CMD_PATH environment variable.
# For Windows development, keep the explicit path.
tesseract_cmd_path = os.getenv('TESSERACT_CMD_PATH')
if tesseract_cmd_path:
    pytesseract.pytesseract.tesseract_cmd = tesseract_cmd_path
else:
    # Default for Windows development or if Tesseract is in system PATH
    pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'

def classify_image(
    image_bytes: bytes, width: int, height: int,
     page_width: float, page_height: float,
    seen_hashes: set, junk_hashes: set
) ->Tuple[str, str | None]:
    """
    Classifies an image using smart detection for text vs graphics content.
    """
    try:
        img_hash = hashlib.sha256(image_bytes).hexdigest()

        # 1. First, check if this hash is already confirmed junk.
        if img_hash in junk_hashes:
            print("Image is junk.")
            return ('background', None)
        
        # 2. Second, check if we've seen this hash before.
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

    try:
        image = Image.open(io.BytesIO(image_bytes))
        
        # Get OCR data with bounding boxes
        ocr_data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
        ocr_text = pytesseract.image_to_string(image).strip()
        
        if len(ocr_text) > 100:
            # Analyze if image has significant non-text content
            has_drawings = detect_non_text_content(image, ocr_data)
            
            if has_drawings:
                print("Image has mixed content, using Vision AI.")
                return ('vision', None)
            else:
                print("Image is text-heavy, using OCR.")
                return ('ocr', ocr_text)
                
    except Exception as e:
        print(f"Content analysis/OCR error: {e}")
        return ('vision', None)
    
    return ('vision', None)

def detect_non_text_content(image, ocr_data):
    """Detect if image has significant drawing/graphic content"""
    
    # 1. Get background color (most common color at edges)
    bg_color = get_background_color(image)
    
    # 2. Get text regions and their colors
    text_regions = get_text_regions(ocr_data)
    text_colors = get_text_colors(image, text_regions)
    
    # 3. Calculate non-text pixel density
    non_text_density = calculate_non_text_density(image, text_regions, bg_color, text_colors);
    
    # 4. Detect edge concentration (drawings often have many edges)
    edge_density = calculate_edge_density(image, text_regions)
    
    # Decision thresholds
    return non_text_density > 0.15 or edge_density > 0.3

def get_background_color(image):
    """Get most common color at image edges"""
    img_array = np.array(image.convert('RGB'))
    h, w = img_array.shape[:2]
    
    # Sample edge pixels
    edge_pixels = np.concatenate([
        img_array[0, :].reshape(-1, 3),      # top edge
        img_array[-1, :].reshape(-1, 3),     # bottom edge
        img_array[:, 0].reshape(-1, 3),      # left edge
        img_array[:, -1].reshape(-1, 3)      # right edge
    ])
    
    # Find most common color
    unique_colors, counts = np.unique(edge_pixels, axis=0, return_counts=True)
    return tuple(unique_colors[np.argmax(counts)])

def get_text_regions(ocr_data):
    """Extract bounding boxes of detected text"""
    regions = []
    for i, conf in enumerate(ocr_data['conf']):
        if int(conf) > 30:  # Only confident detections
            regions.append(
                (ocr_data['left'][i],
                 ocr_data['top'][i],
                 ocr_data['left'][i] + ocr_data['width'][i],
                 ocr_data['top'][i] + ocr_data['height'][i])
            )
    return regions

def get_text_colors(image, text_regions):
    """Sample colors from text regions"""
    img_array = np.array(image.convert('RGB'))
    text_colors = set()
    
    for x1, y1, x2, y2 in text_regions:
        # Sample center of text region
        center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
        if 0 <= center_y < img_array.shape[0] and 0 <= center_x < img_array.shape[1]:
            color = tuple(img_array[center_y, center_x])
            text_colors.add(color)
    
    return text_colors

def calculate_non_text_density(image, text_regions, bg_color, text_colors):
    """Calculate ratio of pixels that are neither background nor text"""
    img_array = np.array(image.convert('RGB'))
    total_pixels = img_array.shape[0] * img_array.shape[1]
    
    # Create mask for text regions
    text_mask = np.zeros(img_array.shape[:2], dtype=bool)
    for x1, y1, x2, y2 in text_regions:
        text_mask[y1:y2, x1:x2] = True
    
    # Count non-background, non-text pixels
    non_text_pixels = 0
    known_colors = text_colors | {bg_color}
    
    for y in range(0, img_array.shape[0], 5):  # Sample every 5th pixel for speed
        for x in range(0, img_array.shape[1], 5):
            if not text_mask[y, x]:  # Not in text region
                pixel_color = tuple(img_array[y, x])
                # Check if pixel is significantly different from known colors
                if not any(color_distance(pixel_color, known) < 30 for known in known_colors):
                    non_text_pixels += 1
    
    return non_text_pixels / (total_pixels / 25)  # Adjust for sampling

def calculate_edge_density(image, text_regions):
    """Calculate edge density outside text regions"""
    # Convert to grayscale and apply edge detection
    gray = image.convert('L')
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edge_array = np.array(edges)
    
    # Create mask for non-text areas
    non_text_mask = np.ones(edge_array.shape, dtype=bool)
    for x1, y1, x2, y2 in text_regions:
        non_text_mask[y1:y2, x1:x2] = False
    
    # Calculate edge density in non-text areas
    edge_pixels = np.sum(edge_array[non_text_mask] > 50)
    total_non_text_pixels = np.sum(non_text_mask)
    
    return edge_pixels / total_non_text_pixels if total_non_text_pixels > 0 else 0

def color_distance(color1, color2):
    """Calculate Euclidean distance between two RGB colors"""
    return sum((a - b) ** 2 for a, b in zip(color1, color2)) ** 0.5

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


def classify_image(
    image_bytes: bytes, width: int, height: int,
     page_width: float, page_height: float,
    seen_hashes: set, junk_hashes: set
) ->Tuple[str, str | None]:
    """
    Classifies an image using smart detection for text vs graphics content.
    """
    try:
        img_hash = hashlib.sha256(image_bytes).hexdigest()

        # 1. First, check if this hash is already confirmed junk.
        if img_hash in junk_hashes:
            print("Image is junk.")
            return ('background', None)
        
        # 2. Second, check if we've seen this hash before.
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

    try:
        image = Image.open(io.BytesIO(image_bytes))
        
        # Get OCR data with bounding boxes
        ocr_data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
        ocr_text = pytesseract.image_to_string(image).strip()
        
        if len(ocr_text) > 100:
            # Analyze if image has significant non-text content
            has_drawings = detect_non_text_content(image, ocr_data)
            
            if has_drawings:
                print("Image has mixed content, using Vision AI.")
                return ('vision', None)
            else:
                print("Image is text-heavy, using OCR.")
                return ('ocr', ocr_text)
                
    except Exception as e:
        print(f"Content analysis/OCR error: {e}")
        return ('vision', None)
    
    return ('vision', None)

def detect_non_text_content(image, ocr_data):
    """Detect if image has significant drawing/graphic content"""
    
    # 1. Get background color (most common color at edges)
    bg_color = get_background_color(image)
    
    # 2. Get text regions and their colors
    text_regions = get_text_regions(ocr_data)
    text_colors = get_text_colors(image, text_regions)
    
    # 3. Calculate non-text pixel density
    non_text_density = calculate_non_text_density(image, text_regions, bg_color, text_colors)
    
    # 4. Detect edge concentration (drawings often have many edges)
    edge_density = calculate_edge_density(image, text_regions)
    
    # Decision thresholds
    return non_text_density > 0.15 or edge_density > 0.3

def get_background_color(image):
    """Get most common color at image edges"""
    img_array = np.array(image.convert('RGB'))
    h, w = img_array.shape[:2]
    
    # Sample edge pixels
    edge_pixels = np.concatenate([
        img_array[0, :].reshape(-1, 3),      # top edge
        img_array[-1, :].reshape(-1, 3),     # bottom edge
        img_array[:, 0].reshape(-1, 3),      # left edge
        img_array[:, -1].reshape(-1, 3)      # right edge
    ])
    
    # Find most common color
    unique_colors, counts = np.unique(edge_pixels, axis=0, return_counts=True)
    return tuple(unique_colors[np.argmax(counts)])

def get_text_regions(ocr_data):
    """Extract bounding boxes of detected text"""
    regions = []
    for i, conf in enumerate(ocr_data['conf']):
        if int(conf) > 30:  # Only confident detections
            regions.append((
                ocr_data['left'][i],
                ocr_data['top'][i],
                ocr_data['left'][i] + ocr_data['width'][i],
                ocr_data['top'][i] + ocr_data['height'][i]
            ))
    return regions

def get_text_colors(image, text_regions):
    """Sample colors from text regions"""
    img_array = np.array(image.convert('RGB'))
    text_colors = set()
    
    for x1, y1, x2, y2 in text_regions:
        # Sample center of text region
        center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
        if 0 <= center_y < img_array.shape[0] and 0 <= center_x < img_array.shape[1]:
            color = tuple(img_array[center_y, center_x])
            text_colors.add(color)
    
    return text_colors

def calculate_non_text_density(image, text_regions, bg_color, text_colors):
    """Calculate ratio of pixels that are neither background nor text"""
    img_array = np.array(image.convert('RGB'))
    total_pixels = img_array.shape[0] * img_array.shape[1]
    
    # Create mask for text regions
    text_mask = np.zeros(img_array.shape[:2], dtype=bool)
    for x1, y1, x2, y2 in text_regions:
        text_mask[y1:y2, x1:x2] = True
    
    # Count non-background, non-text pixels
    non_text_pixels = 0
    known_colors = text_colors | {bg_color}
    
    for y in range(0, img_array.shape[0], 5):  # Sample every 5th pixel for speed
        for x in range(0, img_array.shape[1], 5):
            if not text_mask[y, x]:  # Not in text region
                pixel_color = tuple(img_array[y, x])
                # Check if pixel is significantly different from known colors
                if not any(color_distance(pixel_color, known) < 30 for known in known_colors):
                    non_text_pixels += 1
    
    return non_text_pixels / (total_pixels / 25)  # Adjust for sampling

def calculate_edge_density(image, text_regions):
    """Calculate edge density outside text regions"""
    # Convert to grayscale and apply edge detection
    gray = image.convert('L')
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edge_array = np.array(edges)
    
    # Create mask for non-text areas
    non_text_mask = np.ones(edge_array.shape, dtype=bool)
    for x1, y1, x2, y2 in text_regions:
        non_text_mask[y1:y2, x1:x2] = False
    
    # Calculate edge density in non-text areas
    edge_pixels = np.sum(edge_array[non_text_mask] > 50)
    total_non_text_pixels = np.sum(non_text_mask)
    
    return edge_pixels / total_non_text_pixels if total_non_text_pixels > 0 else 0

def color_distance(color1, color2):
    """Calculate Euclidean distance between two RGB colors"""
    return sum((a - b) ** 2 for a, b in zip(color1, color2)) ** 0.5

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