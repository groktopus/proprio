import * as React from "react";
import { createRoot } from "react-dom/client";

import { RunnerConsoleApp } from "@groktopus/proprio-runner/react";
import "@groktopus/proprio-runner/styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Reference console root is missing.");
createRoot(root).render(<React.StrictMode><RunnerConsoleApp /></React.StrictMode>);
