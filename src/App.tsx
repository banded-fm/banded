import { createHashRouter, RouterProvider, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { ExplorePage } from "./pages/ExplorePage";
import { PlayPage } from "./pages/PlayPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { SimilarityPage } from "./pages/SimilarityPage";
import { AboutPage } from "./pages/AboutPage";
import { RouteError } from "./components/RouteError";
import { isStaleFileError, reloadForNewVersion } from "./staleVersion";

// A data router (createHashRouter) rather than <HashRouter>: links with
// `viewTransition` (home <-> the other pages) only animate with one.
const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      {
        // A page that fails shows RouteError inside the nav bar and footer (not React Router's bare default)
        errorElement: <RouteError />,
        children: [
          { path: "/", element: <HomePage /> },
          { path: "/graph", element: <ExplorePage /> },
          { path: "/play", element: <PlayPage /> },
          { path: "/upcoming", element: <DiscoverPage /> },
          { path: "/proximity", element: <SimilarityPage /> },
          { path: "/about", element: <AboutPage /> },
          // Loaded on demand, with the map library. Its file missing (a deploy since this tab opened): reload once for
          // the new version, waiting meanwhile; past that, RouteError.
          {
            path: "/map",
            lazy: () => import("./pages/ScenesPage")
              .then((m) => ({ Component: m.ScenesPage }))
              .catch((e: unknown) => {
                if (isStaleFileError(e) && reloadForNewVersion()) return new Promise<never>(() => {});
                throw e;
              }),
          },
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]);

function App() {
  return <RouterProvider router={router} />;
}

export default App;
