import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppProviders } from './providers/AppProviders'
import { ThemeProvider } from './app/ThemeContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </AppProviders>
  </StrictMode>,
)
