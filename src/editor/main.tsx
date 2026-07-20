import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/global.css';
import '../styles/document.css';
import './editor.css';
import { EditorApp } from './EditorApp';
createRoot(document.getElementById('root')!).render(<StrictMode><EditorApp /></StrictMode>);
