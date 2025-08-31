import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const bedrockLlamaClient = {
  getGenerativeModel({ model }: { model: string }) {
    if (model === 'text-embedding-004') {
      return {
        async embedContent(text: string) {
          const command = new InvokeModelCommand({
            modelId: 'amazon.titan-embed-text-v2:0',
            body: JSON.stringify({
              inputText: text
            }),
          });
          
          const response = await client.send(command);
          const result = JSON.parse(new TextDecoder().decode(response.body));
          
          return {
            embedding: {
              values: result.embedding
            }
          };
        }
      };
    }
    
    if (model === 'gemini-1.5-pro-latest') {
      return {
        async generateContent(request: unknown) {
          // Handle both formats
          let parts;
          if (Array.isArray(request)) {
            parts = request;
          } else {
            const req = request as { contents?: { parts?: unknown[] }[] };
            if (req.contents && req.contents[0] && req.contents[0].parts) {
              parts = req.contents[0].parts;
            } else {
              throw new Error('Invalid request format');
            }
          }
          
          const prompt = parts.map((p: { text?: string }) => p.text || p).join('');
          const images = parts.filter((p: { inlineData?: { mimeType: string; data: string } }) => p.inlineData);
          
          // Llama 3.2 90B Vision format using Converse API
          const content = [];
          
          // Add text
          if (prompt) {
            content.push({ text: prompt });
          }
          
          // Add images (convert base64 to bytes)
          images.forEach((img: { inlineData: { mimeType: string; data: string } }) => {
            const imageBytes = Buffer.from(img.inlineData.data, 'base64');
            content.push({
              image: {
                format: img.inlineData.mimeType.split('/')[1], // jpeg or png
                source: {
                  bytes: imageBytes
                }
              }
            });
          });
          
          const params: ConverseCommandInput = {
            modelId: 'us.meta.llama3-2-90b-instruct-v1:0',
            messages: [{
              role: 'user' as const,
              content: content
            }]
          };
          
          const command = new ConverseCommand(params);
          
          // Retry logic for throttling
          let retries = 3;
          while (retries > 0) {
            try {
              const response = await client.send(command);
              
              return {
                response: {
                  text: () => response.output?.message?.content?.[0]?.text || 'No response generated'
                }
              };
            } catch (error: unknown) {
              const err = error as { name?: string };
              if (err.name === 'ThrottlingException' && retries > 1) {
                retries--;
                await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries)));
                continue;
              }
              throw error;
            }
          }
        },
        
        async generateContentStream(request: unknown) {
          const result = await this.generateContent(request);
          if (!result) {
            throw new Error('Failed to generate content');
          }
          const fullText = result.response.text();
          
          const stream = (async function* () {
            const words = fullText.split(' ');
            for (let i = 0; i < words.length; i++) {
              const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
              yield {
                text: () => chunk,
                candidates: [{
                  content: {
                    parts: [{ text: chunk }]
                  }
                }]
              };
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          })();
          
          return { stream };
        }
      };
    }
    
    throw new Error(`Unsupported model: ${model}`);
  }
};

export default bedrockLlamaClient;