import { StyledEngineProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "./index.css";
import { appRoutes } from "./routes";

const router = createBrowserRouter(appRoutes);

// MUIのスタイルを、Tailwindより前に差し込み、`@layer mui` に入れる(順序は index.css で固定)。
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <StyledEngineProvider injectFirst enableCssLayer>
      <CssBaseline />
      <RouterProvider router={router} />
    </StyledEngineProvider>
  </StrictMode>,
);
