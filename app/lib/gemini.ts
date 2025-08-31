import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error('GOOGLE_API_KEY is not defined');
}
const client = new GoogleGenerativeAI(apiKey);

const geminiClient = {
  getGenerativeModel({ model }: { model: string }) {
    if (model === 'text-embedding-004') {
      const embeddingModel = client.getGenerativeModel({ model });
      return {
        async embedContent(text: string) {
          const result = await embeddingModel.embedContent(text);
          // Pad 768 to 1024 dimensions
          const padded = [...result.embedding.values, ...new Array(256).fill(0)];
          return {
            embedding: {
              values: padded
            }
          };
        }
      };
    }
    
    // For other models, use original client
    return client.getGenerativeModel({ model });
  }
};

export default geminiClient;