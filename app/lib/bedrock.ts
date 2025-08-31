import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Exact Gemini API wrapper for Bedrock
const bedrockClient = {
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
          // Handle both formats: array [prompt, imagePart] or object {contents: [{parts: [...]}]}
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
          
          const content: Array<{ text?: string; image?: { format: string; source: { bytes: string } } }> = [{ text: prompt }];
          
          // Add images in Nova Pro format
          images.forEach((img: { inlineData: { mimeType: string; data: string } }) => {
            content.push({
              image: {
                format: img.inlineData.mimeType.split('/')[1],
                source: {
                  bytes: img.inlineData.data
                }
              }
            });
          });
          
          const body = {
            messages: [{
              role: "user",
              content: content
            }],
            inferenceConfig: {
              max_new_tokens: 4000,
              temperature: 0.7
            }
          };
          
          const command = new InvokeModelCommand({
            modelId: 'us.amazon.nova-pro-v1:0',
            body: JSON.stringify(body),
          });
          
          // Retry logic for throttling
          let retries = 3;
          while (retries > 0) {
            try {
              const response = await client.send(command);
              const result = JSON.parse(new TextDecoder().decode(response.body));
              
              return {
                response: {
                  text: () => result.output?.message?.content?.[0]?.text || 'No response generated'
                }
              };
            } catch (error: unknown) {
              const err = error as { name?: string };
              if (err.name === 'ThrottlingException' && retries > 1) {
                retries--;
                await new Promise(resolve => setTimeout(resolve, 3000 * (4 - retries))); // 3s, 6s, 9s delays
                continue;
              }
              throw error;
            }
          }
        },
        
        async generateContentStream(request: unknown) {
          // Get the full response first
          const result = await this.generateContent(request);
          if (!result) {
            throw new Error('Failed to generate content');
          }
          const fullText = result.response.text();
          
          // Create a Gemini-compatible stream that yields chunks
          const stream = (async function* () {
            // Split text into words for streaming effect
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
              // Small delay to simulate streaming
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

export default bedrockClient;