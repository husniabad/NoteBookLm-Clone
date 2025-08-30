import { GoogleGenerativeAI } from '@google/generative-ai';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error('GOOGLE_API_KEY is not defined');
}
const genAI = new GoogleGenerativeAI(apiKey);

export default genAI;