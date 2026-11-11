import { createHashRouter, RouterProvider, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/HomePage";
import { ExplorePage } from "./pages/ExplorePage";
import { PlayPage } from "./pages/PlayPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { SimilarityPage } from "./pages/SimilarityPage";
import { AboutPage } from "./pages/AboutPage";

// A data router (createHashRouter) rather than <HashRouter>: links with
// `viewTransition` (home <-> the other pages) only animate with one.
const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/explore", element: <ExplorePage /> },
      { path: "/play", element: <PlayPage /> },
      { path: "/discover", element: <DiscoverPage /> },
      { path: "/similarity", element: <SimilarityPage /> },
      { path: "/about", element: <AboutPage /> },
      // Loaded on demand, with the map library.
      { path: "/scenes", lazy: () => import("./pages/ScenesPage").then((m) => ({ Component: m.ScenesPage })) },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

function App() {
  return <RouterProvider router={router} />;
}

export default App;
