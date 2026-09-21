// @types/react-dom が導入されるまでの暫定の型宣言(main.tsx が使う createRoot だけ)。
declare module "react-dom/client" {
  import type { ReactNode } from "react";
  export function createRoot(container: Element | DocumentFragment): {
    render(children: ReactNode): void;
    unmount(): void;
  };
}
