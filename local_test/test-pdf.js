import pdf2pic from 'pdf2pic';
import { promises as fs } from 'fs';
import path from 'path';

// --- Configuration ---
const INPUT_PDF_PATH = './local_test/test-doc.pdf';
const OUTPUT_DIR = './local_test/output_images';

async function testPdfImageExtraction() {
  try {
    console.log('Starting PDF image extraction test...');
    
    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Configure pdf2pic
    const options = {
      density: 100,
      savePath: OUTPUT_DIR,
      saveFilename: "page_image",
      format: "png",
      width: 800,
      height: 1100,
    };

    const convert = pdf2pic.fromPath(INPUT_PDF_PATH, options);

    // Convert all pages. The result is an array of objects with file info.
    const results = await convert.bulk(-1, { responseType: "image" });
    console.log('Conversion successful! See results below:');
    console.log(results);

    console.log(`✅ Success! Check the '${OUTPUT_DIR}' folder for the extracted images.`);

  } catch (error) {
    console.error('❌ Test failed. Error details:', error);
  }
}

testPdfImageExtraction();