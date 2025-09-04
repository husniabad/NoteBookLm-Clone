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
    
    // Map model names to actual Gemini models
    const modelMap: { [key: string]: string } = {
      'gemini-1.5-flash': 'gemini-1.5-flash-latest',
      'gemini-1.5-pro': 'gemini-1.5-pro-latest'
    };
    
    const actualModel = modelMap[model] || model;
    return client.getGenerativeModel({ model: actualModel });
  }
};

export default geminiClient;