import fetch from 'node-fetch';
import FormData from 'form-data';
import pdf2pic from 'pdf2pic';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';

export interface PDFPageImage {
  buffer: Buffer;
  pageNumber: number;
}

export async function convertPDFToImages(fileBuffer: Buffer): Promise<PDFPageImage[]> {
  // const isProduction = process.env.VERCEL_ENV === 'production';
  const isProduction = true;
  
  if (isProduction) {
    return convertWithConvertAPI(fileBuffer);
  } else {
    return convertWithPdf2pic(fileBuffer);
  }
}

async function convertWithConvertAPI(fileBuffer: Buffer): Promise<PDFPageImage[]> {
  console.log('ConvertAPI attempt:', {
    fileSize: `${(fileBuffer.length / 1024).toFixed(1)}KB`,
    hasSecret: !!process.env.CONVERTAPI_SECRET
  });
  
  try {
    // Check if file is too large for ConvertAPI
    const maxSize = 10 * 1024 * 1024; // 10MB limit
    if (fileBuffer.length > maxSize) {
      console.log(`PDF too large (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB), using fallback`);
      throw new Error('File too large for ConvertAPI');
    }
    
    console.log('Making ConvertAPI request with headers...');
    const formData = new FormData();
    formData.append('File', fileBuffer, {
      filename: 'document.pdf',
      contentType: 'application/pdf'
    });
    formData.append('ImageResolution', '72'); // Very low resolution
    
    const response = await fetch(`https://v2.convertapi.com/convert/pdf/to/png?Secret=${process.env.CONVERTAPI_SECRET}`, {
      method: 'POST',
      body: formData,
      headers: {
        ...formData.getHeaders()
      }
    });
    
    console.log('ConvertAPI response status:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error details');
      console.error('ConvertAPI failed:', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
        headers: Object.fromEntries(response.headers.entries())
      });
      
      if (response.status === 413) {
        throw new Error('PDF file too large for ConvertAPI');
      }
      throw new Error(`ConvertAPI error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json() as { Files: Array<{ FileData: string }> };
    
    if (!result.Files || result.Files.length === 0) {
      throw new Error('No files returned from ConvertAPI');
    }
    
    const pages: PDFPageImage[] = [];
    
    for (let i = 0; i < result.Files.length; i++) {
      const fileResult = result.Files[i];
      const imageBuffer = Buffer.from(fileResult.FileData, 'base64');
      
      const originalMeta = await sharp(imageBuffer).metadata();
      const resizedBuffer = await sharp(imageBuffer).resize({ width: 800 }).toBuffer();
      const resizedMeta = await sharp(resizedBuffer).metadata();
      
      console.log(`Page ${i + 1}: ${originalMeta.width}×${originalMeta.height} → ${resizedMeta.width}×${resizedMeta.height}`);
      
      pages.push({
        buffer: resizedBuffer,
        pageNumber: i + 1
      });
    }
    
    return pages;
  } catch (error) {
    console.error('ConvertAPI error:', error);
    throw new Error(`ConvertAPI failed: ${error}`);
  }
}

async function convertWithPdf2pic(fileBuffer: Buffer): Promise<PDFPageImage[]> {
  const tempDir = path.join(tmpdir(), `pdf_images_${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  
  const tempPdfPath = path.join(tempDir, 'temp.pdf');
  await fs.writeFile(tempPdfPath, fileBuffer);
  
  const options = {
    density: 100,
    savePath: tempDir,
    saveFilename: "page_image",
    format: "png" as const,
    width: 400,
    height: 550,
  };

  const convert = pdf2pic.fromPath(tempPdfPath, options);
  const results = await convert.bulk(-1, { responseType: "image" });
  
  const pages: PDFPageImage[] = [];
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result.path) continue;
    
    const imageBuffer = await fs.readFile(result.path);
    const metadata = await sharp(imageBuffer).metadata();
    const resizedBuffer = metadata.width && metadata.width > 800 
      ? await sharp(imageBuffer).resize({ width: 800 }).toBuffer()
      : imageBuffer;
    
    pages.push({
      buffer: resizedBuffer,
      pageNumber: i + 1
    });
  }
  
  await fs.rm(tempDir, { recursive: true, force: true });
  return pages;
}