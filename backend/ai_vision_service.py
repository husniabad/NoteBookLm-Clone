import aiohttp
import asyncio
import base64
import json
from typing import Dict, Any

async def get_ai_visual_analysis(session: aiohttp.ClientSession, image_bytes: bytes, vision_api_url: str) -> Dict[str, Any]:
    """Gets a structured JSON analysis with rate limit handling."""
    headers = {"Content-Type": "application/json"}
    prompt = """Analyze the image in extreme detail. First, classify it as "substantive" (e.g., a photograph, chart, diagram, table, document scan) or "decorative" (e.g., a simple icon, logo, border, ornamental graphic).

If the image is **SUBSTANTIVE**, you must perform a comprehensive and exhaustive analysis. Your goal is to create a description so detailed that someone could reconstruct the image's key elements and meaning without seeing it. Cover the following aspects meticulously:

1.  **Overall Summary**: Start with a concise one-sentence summary of the image's subject and purpose.
2.  **Content Type**: Explicitly state the type of content (e.g., 'bar chart', 'photograph of a cityscape', 'scanned document page', 'architectural diagram').
3.  **Raw Text Extraction**: Extract ALL visible text, numbers, and symbols, no matter how small. Preserve the original formatting and line breaks as much as possible. This is critical.
4.  **Visual Elements & Layout**:
    *   **Composition**: Describe the overall layout. Where are the main elements positioned (e.g., 'a chart occupies the top half, with a legend on the bottom right').
    *   **Colors**: Describe the dominant color palette and the colors of key elements.
    *   **Style**: Is it a photograph, illustration, sketch, 3D render? Is it realistic, abstract, cartoonish?
5.  **Detailed Subject Analysis**:
    *   **For Charts/Graphs/Tables**: Extract every single data point, label, axis value, and legend entry. For a bar chart, list the value of each bar. For a table, transcribe every cell.
    *   **For Photographs/Illustrations**:
        *   **People**: Describe each person's approximate age, gender, clothing (colors, style), posture, expression, and any action they are performing.
        *   **Objects**: Identify all significant objects. Describe their color, material, texture, brand names, and any text on them.
        *   **Setting/Environment**: Describe the location (e.g., 'office board room', 'city street at night', 'forest'). Mention lighting, weather, and time of day if discernible.
    *   **For Documents/Diagrams**: Describe the structure of the document (e.g., 'a two-column layout with a header'). Transcribe all text as mentioned before, and describe any diagrams, flowcharts, or schematics, including the shapes, connectors, and labels.
6.  **Inferred Context & Purpose**: What is the likely purpose of this image? What information is it trying to convey?

If the image is **DECORATIVE**, provide a brief, one-sentence description of what it depicts (e.g., 'A blue and white company logo.').

**Output Format**: You MUST return a single, valid JSON object with the following structure. Do not include any text or formatting outside of this JSON object.
{
  "contentType": "substantive" | "decorative",
  "description": "Your detailed analysis goes here. For substantive images, this should be a multi-paragraph, exhaustive description. For decorative, a single sentence.",
  "rawText": "All extracted text, numbers, and symbols go here. If no text is present, provide an empty string."
}"""
    
    payload = {
        "contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(image_bytes).decode()}}]}],
        "generationConfig": {"responseMimeType": "application/json"}
    }
    
    retries = 3
    while retries > 0:
        try:
            async with session.post(vision_api_url, json=payload, headers=headers) as response:
                if response.status == 200:
                    data = await response.json()
                    try:
                        json_text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "{}")
                        return json.loads(json_text)
                    except (json.JSONDecodeError, IndexError):
                        return {"description": "AI analysis failed to return valid JSON.", "contentType": "error", "rawText": ""}
                        
                elif response.status == 429:  # Rate limit
                    retries -= 1
                    if retries > 0:
                        wait_time = (4 - retries) * 2
                        await asyncio.sleep(wait_time)
                        continue
                    return {"description": "Rate limit exceeded", "contentType": "error", "rawText": ""}
                else:
                    return {"description": f"API error {response.status}", "contentType": "error", "rawText": ""}
                    
        except (aiohttp.ClientError, asyncio.TimeoutError):
            retries -= 1
            if retries > 0:
                await asyncio.sleep(5)
            else:
                return {"description": "Network error", "contentType": "error", "rawText": ""}
    
    return {"description": "Failed after retries", "contentType": "error", "rawText": ""}