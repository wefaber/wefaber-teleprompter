/// <reference types="vite/client" />

// Bun lo importa como texto en los tests (`with { type: "text" }`).
declare module "*.md" {
  const text: string;
  export default text;
}
