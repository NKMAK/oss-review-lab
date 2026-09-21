import { Navigate } from "react-router";
import type { RouteObject } from "react-router";
import { Layout } from "./layout/Layout";
import ExclusionReviewPage from "./pages/ExclusionReviewPage";
import JevPage from "./pages/JevPage";
import NotFoundPage from "./pages/NotFoundPage";
import ThreadDetailPage from "./pages/ThreadDetailPage";
import ThreadListPage from "./pages/ThreadListPage";

/**
 * ルーティングの定義。画面の追加・差し替えは、ここではなく `pages/` の各ファイルで行う
 * (後続タスクがこのファイルを触らなくて済むようにしてある)。
 */
export const appRoutes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Navigate to="/threads" replace /> },
      { path: "/threads", element: <ThreadListPage /> },
      { path: "/threads/:id", element: <ThreadDetailPage /> },
      { path: "/review/exclusion", element: <ExclusionReviewPage /> },
      { path: "/jev", element: <JevPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
