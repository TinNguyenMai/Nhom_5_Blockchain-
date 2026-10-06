import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
const Simulation = lazy(() => import('./Simulation.jsx'));
import './style.css';
createRoot(document.getElementById('root')).render(window.location.pathname === '/simulation' ? <Suspense fallback={<p>Đang tải mô phỏng…</p>}><Simulation/></Suspense> : <App/>);
