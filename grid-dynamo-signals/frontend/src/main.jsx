import React from "react";
import { createRoot } from "react-dom/client";
import DynamoDashboard from "./DynamoDashboard.jsx";
import "./weighted-reference.css";
import "./dynamo.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DynamoDashboard />
  </React.StrictMode>,
);
