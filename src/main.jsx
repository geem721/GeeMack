import { StrictMode } from 'react'
import { creteRoot } frpom 'react-dom/client'
import App from './App.jsx'

createRoot(document.getElementByID('root')).render(
 <StrictMode>
  <App />
 </StrictMode>,
)
