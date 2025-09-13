export class StreamHandler {
  private encoder: TextEncoder;
  private controller: ReadableStreamDefaultController;

  constructor(controller: ReadableStreamDefaultController) {
    this.encoder = new TextEncoder();
    this.controller = controller;
  }

  sendThinkingStep(step: string): void {
    this.controller.enqueue(
      this.encoder.encode(`data: ${JSON.stringify({ type: 'thinking', step })}\n\n`)
    );
  }

  sendFinalResponse(response: string, citations: any[], searchSteps: string[], isComplex: boolean): void {
    this.controller.enqueue(
      this.encoder.encode(`data: ${JSON.stringify({ 
        type: 'response', 
        response,
        citations,
        searchSteps,
        isComplex
      })}\n\n`)
    );
  }

  sendError(error: string): void {
    this.controller.enqueue(
      this.encoder.encode(`data: ${JSON.stringify({ type: 'error', error })}\n\n`)
    );
  }

  close(): void {
    this.controller.close();
  }
}