import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export async function uploadToS3(buffer: Buffer, fileName: string, contentType: string): Promise<string> {
  const key = `uploads/${Date.now()}-${fileName}`;
  
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET!.replace(/"/g, ''),
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await s3Client.send(command);
  
  return `https://${process.env.AWS_S3_BUCKET!.replace(/"/g, '')}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}