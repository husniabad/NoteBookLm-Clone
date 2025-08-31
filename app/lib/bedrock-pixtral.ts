import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const bedrockPixtralClient = {
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
          
          const messages = [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt
                },
                ...images.map((img: { inlineData: { mimeType: string; data: string } }) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: img.inlineData.mimeType,
                    data: img.inlineData.data
                  }
                }))
              ]
            }
          ];
          
          const body = {
            messages: messages,
            max_tokens: 4000,
            temperature: 0.7
          };
          
          const command = new ConverseCommand({
            modelId: 'us.mistral.pixtral-large-2502-v1:0',
            messages: [{
              role: 'user',
              content: [
                { text: prompt },
                ...images.map((img: { inlineData: { mimeType: string; data: string } }) => ({
                  image: {
                    format: img.inlineData.mimeType.split('/')[1] as 'jpeg' | 'png' | 'gif' | 'webp',
                    source: {
                      bytes: new Uint8Array(Buffer.from(img.inlineData.data, 'base64'))
                    }
                  }
                }))
              ]
            }],
            inferenceConfig: {
              maxTokens: 4000,
              temperature: 0.7
            }
          });
          
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
                await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries))); // 2s, 4s, 6s delays
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

export default bedrockPixtralClient;