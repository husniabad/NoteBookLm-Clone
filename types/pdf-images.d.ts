declare module 'pdf-images' {
  function pdfImages(buffer: Buffer): Promise<Buffer[]>;
  export = pdfImages;
}