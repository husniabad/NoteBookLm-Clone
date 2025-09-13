require('dotenv').config({ path: '.env.local' });
const { list, del } = require('@vercel/blob');

async function deleteAllBlobs() {
  try {
    console.log('Fetching all blobs...');
    const { blobs } = await list();
    
    if (blobs.length === 0) {
      console.log('No blobs found to delete.');
      return;
    }
    
    console.log(`Found ${blobs.length} blobs. Deleting...`);
    
    const deletePromises = blobs.map(blob => {
      console.log(`Deleting: ${blob.pathname}`);
      return del(blob.url);
    });
    
    await Promise.all(deletePromises);
    
    console.log(`Successfully deleted ${blobs.length} blobs.`);
  } catch (error) {
    console.error('Error deleting blobs:', error);
  }
}

deleteAllBlobs();