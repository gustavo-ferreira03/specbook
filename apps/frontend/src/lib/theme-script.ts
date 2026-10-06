export const THEME_STORAGE_KEY = "specbook:theme";

/**
 * Runs synchronously in <head> before first paint (see app/layout.tsx), so the stored or system
 * theme is applied without a flash. Keep it dependency-free and in sync with applyTheme().
 */
export const THEME_INIT_SCRIPT = `(function(){try{var p=null;try{p=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}if(p!=="light"&&p!=="dark")p="system";var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.dataset.theme=p}catch(e){}})()`;
