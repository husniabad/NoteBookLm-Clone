import boto3
import mimetypes
import os
from botocore.exceptions import ClientError

class AWSS3:
    def __init__(self, bucket_name: str):
        self.bucket_name = bucket_name
        self.s3_client = boto3.client(
            's3',
            aws_access_key_id=os.getenv('AWS_ACCESS_KEY_ID'),
            aws_secret_access_key=os.getenv('AWS_SECRET_ACCESS_KEY'),
            region_name=os.getenv('AWS_REGION', 'us-east-1')
        )
    
    async def put(self, session, filename: str, file_bytes: bytes) -> str:
        """Upload file to S3 with inline Content-Disposition"""
        try:
            content_type, _ = mimetypes.guess_type(filename)
            if not content_type:
                content_type = 'application/octet-stream'
            
            # Generate unique key
            import uuid
            unique_key = f"{uuid.uuid4().hex[:8]}-{filename}"
            
            # Upload with inline Content-Disposition
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=unique_key,
                Body=file_bytes,
                ContentType=content_type,
                ContentDisposition=f'inline; filename="{filename}"'
            )
            
            # Return public URL
            url = f"https://{self.bucket_name}.s3.amazonaws.com/{unique_key}"
            return url
            
        except ClientError as e:
            print(f"S3 upload error: {e}")
            raise Exception(f"S3 upload failed: {str(e)}")
        except Exception as e:
            print(f"Upload exception: {e}")
            raise