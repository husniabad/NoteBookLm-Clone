export function splitIntoChunks(
    text: string,
    chunkSize: number = 1000,
    overlap: number = 200
):string[] {
    if (overlap >= chunkSize){
        throw new Error("Overlap must be smaller than chunk size");
    }
    const chunks: string[] = [];
    let index = 0;
    while (index < text.length) {
        const end = Math.min(index + chunkSize, text.length);
        chunks.push(text.slice(index, end));
        if (end === text.length) break; // Break if we've reached the end
        index += chunkSize - overlap;
    }
    
    return chunks;
}