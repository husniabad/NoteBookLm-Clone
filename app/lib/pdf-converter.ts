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
  console.log('pdf2pic conversion started:', {
    fileSize: `${(fileBuffer.length / 1024).toFixed(1)}KB`,
    fileSizeMB: `${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB`
  });

    const tempDir = path.join(tmpdir(), `pdf_images_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    const tempPdfPath = path.join(tempDir, 'temp.pdf');
    await fs.writeFile(tempPdfPath, fileBuffer);
    console.log('PDF written to temp file:', tempPdfPath);
    
    const options = {
      density: 100,
      savePath: tempDir,
      saveFilename: "page_image",
      format: "png" as const,
      width: 400,
      height: 550,
    };
    
    const convert = pdf2pic.fromPath(tempPdfPath, options);
    console.log('Starting pdf2pic conversion...');
    const results = await convert.bulk(-1, { responseType: "image" });
    console.log('pdf2pic conversion completed:', results.length, 'pages');
    
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
    console.log('pdf2pic conversion finished:', pages.length, 'pages processed');
    return pages;
}