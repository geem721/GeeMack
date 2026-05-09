import { useState, useRef, useEffect, useCallback } from "react";

const LANGUAGES = [
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "es", label: "Spanish", flag: "🇪🇸" },
  { code: "fr", label: "French", flag: "🇫🇷" },
  { code: "de", label: "German", flag: "🇩🇪" },
  { code: "zh", label: "Chinese", flag: "🇨🇳" },
  { code: "ja", label: "Japanese", flag: "🇯🇵" },
  { code: "ar", label: "Arabic", flag: "🇸🇦" },
  { code: "pt", label: "Portuguese", flag: "🇧🇷" },
  { code: "ru", label: "Russian", flag: "🇷🇺" },
  { code: "hi", label: "Hindi", flag: "🇮🇳" },
  { code: "ko", label: "Korean", flag: "🇰🇷" },
  { code: "it", label: "Italian", flag: "🇮🇹" },
];

const API_KEY = "ANTHROPIC_API_KEY";

const HEADERS = {
  "Content-Type": "application/json",
  "x-api-key": API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
};

export default function App() {
  const [inputText, setInputText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("es");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [activeTab, setActiveTab] = useState("text");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [captions, setCaptions] = useState([]);
  const recognitionRef = useRef(null);
  const chatEndRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const swapLanguages = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    setInputText(translatedText);
    setTranslatedText(inputText);
  };

  const translateText = useCallback(async (text, src, tgt) => {
    if (!text.trim()) {
      setTranslatedText("");
      return;
    }
    setIsTranslating(true);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Translate the following text from ${src} to ${tgt}. Return ONLY the translated text, nothing else:\n\n${text}`
          }]
        })
      });
      const data = await response.json();
      const result = data.content?.[0]?.text || "";
      setTranslatedText(result);
      setCaptions(prev => [...prev.slice(-4), {
        original: text, translated: result, src, tgt,
        time: new Date().toLocaleTimeString()
      }]);
    } catch {
      setTranslatedText("Translation error. Please try again.");
    }
    setIsTranslating(false);
  }, []);

  // Live translation: fires 600ms after user stops typing
  const handleInputChange = (e) => {
    const text = e.target.value;
    setInputText(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim()) {
      debounceRef.current = setTimeout(() => {
        translateText(text, sourceLang, targetLang);
      }, 600);
    } else {
      setTranslatedText("");
    }
  };

  const startVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { alert("Use Chrome for voice features."); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = sourceLang;
    recognition.onresult = (e) => {
      const spoken = e.results[0][0].transcript;
      setInputText(spoken);
      translateText(spoken, sourceLang, targetLang);
    };
    recognition.onend = () => setIsListening(false);
    recognition.start();
    recognitionRef.current = recognition;
    setIsListening(true);
  };

  const speakText = (text, lang) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    window.speechSynthesis.speak(u);
  };

  const sendChatMessage = async () => {
    if (!chatInput.trim()) return;
    const userMsg = { role: "user", text: chatInput };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput("");
    setIsChatLoading(true);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are a multilingual assistant for TalkBridge. The user writes in ${sourceLang} and wants responses in both ${sourceLang} and ${targetLang}.\n\nUser: "${chatInput}"\n\nReply in ${sourceLang}, then on a new line show the ${targetLang} translation in parentheses.`
          }]
        })
      });
      const data = await response.json();
      setChatMessages(prev => [...prev, { role: "assistant", text: data.content?.[0]?.text || "" }]);
    } catch {
      setChatMessages(prev => [...prev, { role: "assistant", text: "Error." }]);
    }
    setIsChatLoading(false);
  };

  const s = styles;
  return (
    <div style={s.app}>
      <header style={s.header}>
        <div style={s.logo}>🌐 <span style={s.logoText}>TalkBridge</span></div>
        <p style={s.tagline}>Real-time AI Translation · Voice · Chat · Captions</p>
      </header>

      <div style={s.tabs}>
        {[["text","📝 Text"],["voice","🎙️ Voice"],["chat","💬 Chat"],["captions","📺 Captions"]].map(([tab,label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            style={{...s.tab, ...(activeTab===tab ? s.tabActive : {})}}>
            {label}
          </button>
        ))}
      </div>

      <div style={s.langBar}>
        <select style={s.select} value={sourceLang} onChange={e => setSourceLang(e.target.value)}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
        </select>
        <button style={s.swapBtn} onClick={swapLanguages}>⇄</button>
        <select style={s.select} value={targetLang} onChange={e => setTargetLang(e.target.value)}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
        </select>
      </div>

      <div style={s.panel}>
        {activeTab === "text" && (
          <>
            <div style={s.liveIndicator}>
              {isTranslating
                ? <span style={{color:"#00d4ff"}}>⟳ Translating...</span>
                : inputText.trim()
                  ? <span style={{color:"#00aa66"}}>✓ Live translation active</span>
                  : <span style={{color:"#2a4a6a"}}>Start typing for live translation</span>}
            </div>
            <div style={s.textRow}>
              <div style={s.textBox}>
                <label style={s.boxLabel}>{LANGUAGES.find(l=>l.code===sourceLang)?.flag} Source</label>
                <textarea
                  style={s.textarea}
                  placeholder="Type to translate instantly..."
                  value={inputText}
                  onChange={handleInputChange}
                  onKeyDown={e => e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),translateText(inputText,sourceLang,targetLang))}
                />
                <div style={s.actions}>
                  <button style={s.iconBtn} onClick={()=>speakText(inputText,sourceLang)}>🔊</button>
                  <button style={s.iconBtn} onClick={()=>navigator.clipboard.writeText(inputText)}>📋</button>
                  <button style={s.iconBtn} onClick={()=>{setInputText("");setTranslatedText("");}}>✕</button>
                </div>
              </div>
              <div style={s.textBox}>
                <label style={s.boxLabel}>{LANGUAGES.find(l=>l.code===targetLang)?.flag} Translation</label>
                <div style={{...s.textarea,...s.output}}>
                  {isTranslating ? <span style={{color:"#00d4ff"}}>Translating...</span>
                    : translatedText || <span style={{color:"#1e3a5f"}}>Translation appears here</span>}
                </div>
                <div style={s.actions}>
                  <button style={s.iconBtn} onClick={()=>speakText(translatedText,targetLang)}>🔊</button>
                  <button style={s.iconBtn} onClick={()=>navigator.clipboard.writeText(translatedText)}>📋</button>
                </div>
              </div>
            </div>
            <button style={s.mainBtn} onClick={()=>translateText(inputText,sourceLang,targetLang)}
              disabled={isTranslating||!inputText.trim()}>
              {isTranslating ? "Translating..." : "Translate →"}
            </button>
          </>
        )}

        {activeTab === "voice" && (
          <div style={s.voiceCenter}>
            <div style={{...s.micRing,...(isListening?s.micRingOn:{})}}>
              <button style={{...s.micBtn,...(isListening?s.micBtnOn:{})}}
                onClick={isListening?(()=>{recognitionRef.current?.stop();setIsListening(false)}):startVoice}>
                {isListening?"⏹":"🎙️"}
              </button>
            </div>
            <p style={{color:"#6ba3be"}}>{isListening?"Listening... speak now":"Tap to speak"}</p>
            {inputText && (
              <div style={s.voiceResult}>
                <p style={{color:"#e8f4fd",margin:"0 0 8px"}}>🗣️ "{inputText}"</p>
                {translatedText && <p style={{color:"#00d4ff",margin:"0 0 12px"}}>🌐 "{translatedText}"</p>}
                {translatedText && <button style={s.speakBtn} onClick={()=>speakText(translatedText,targetLang)}>🔊 Play Translation</button>}
              </div>
            )}
          </div>
        )}

        {activeTab === "chat" && (
          <>
            <div style={s.chatBox}>
              {chatMessages.length===0 && <div style={s.empty}><span style={{fontSize:36}}>💬</span><p>Start a multilingual conversation</p></div>}
              {chatMessages.map((m,i)=>(
                <div key={i} style={{...s.msg,...(m.role==="user"?s.msgUser:s.msgBot)}}>
                  <span style={s.bubble}>{m.text}</span>
                </div>
              ))}
              {isChatLoading && <div style={{...s.msg,...s.msgBot}}><span style={s.bubble}>Translating...</span></div>}
              <div ref={chatEndRef}/>
            </div>
            <div style={s.chatRow}>
              <input style={s.chatInput} placeholder={`Message in ${LANGUAGES.find(l=>l.code===sourceLang)?.label}...`}
                value={chatInput} onChange={e=>setChatInput(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&sendChatMessage()} />
              <button style={s.mainBtn2} onClick={sendChatMessage} disabled={isChatLoading}>Send</button>
            </div>
          </>
        )}

        {activeTab === "captions" && (
          <>
            <div style={s.chatBox}>
              {captions.length===0 && <div style={s.empty}><span style={{fontSize:36}}>📺</span><p>Live captions appear as you translate</p></div>}
              {captions.map((c,i)=>(
                <div key={i} style={{borderBottom:"1px solid #1e3a5f",paddingBottom:12}}>
                  <span style={{fontSize:11,color:"#2a4a6a"}}>{c.time}</span>
                  <p style={{margin:"4px 0",color:"#e8f4fd"}}>{LANGUAGES.find(l=>l.code===c.src)?.flag} {c.original}</p>
                  <p style={{margin:"4px 0",color:"#00d4ff"}}>{LANGUAGES.find(l=>l.code===c.tgt)?.flag} {c.translated}</p>
                </div>
              ))}
            </div>
            <button style={{...s.mainBtn,background:"transparent",border:"1px solid #1e3a5f",color:"#6ba3be"}}
              onClick={()=>setCaptions([])}>Clear Captions</button>
          </>
        )}
      </div>

      <footer style={{padding:20,color:"#1e3a5f",fontSize:12,textAlign:"center"}}>
        TalkBridge · AI-Powered Translation · Built with Claude · github.com/Geem721/GEEMACK
      </footer>
    </div>
  );
}

const styles = {
  app:{minHeight:"100vh",background:"linear-gradient(135deg,#0a0a1a,#0d1b2a,#0a1628)",color:"#e8f4fd",fontFamily:"'Segoe UI',system-ui,sans-serif",display:"flex",flexDirection:"column",alignItems:"center"},
  header:{textAlign:"center",padding:"28px 20px 12px"},
  logo:{display:"flex",alignItems:"center",justifyContent:"center",gap:10,fontSize:28,marginBottom:6},
  logoText:{fontWeight:800,background:"linear-gradient(90deg,#00d4ff,#0099cc)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"},
  tagline:{color:"#6ba3be",fontSize:12,margin:0},
  tabs:{display:"flex",gap:6,padding:"12px 16px 0",flexWrap:"wrap",justifyContent:"center"},
  tab:{padding:"7px 16px",borderRadius:20,border:"1px solid #1e3a5f",background:"transparent",color:"#6ba3be",cursor:"pointer",fontSize:13},
  tabActive:{background:"#00d4ff11",border:"1px solid #00d4ff",color:"#00d4ff"},
  langBar:{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",width:"100%",maxWidth:700,boxSizing:"border-box"},
  select:{flex:1,padding:"9px 10px",borderRadius:10,border:"1px solid #1e3a5f",background:"#0d1b2a",color:"#e8f4fd",fontSize:13},
  swapBtn:{padding:"9px 14px",borderRadius:10,border:"1px solid #00d4ff44",background:"#00d4ff11",color:"#00d4ff",cursor:"pointer",fontSize:16,fontWeight:700},
  panel:{width:"100%",maxWidth:700,padding:"0 16px 20px",boxSizing:"border-box",flex:1},
  liveIndicator:{fontSize:12,padding:"6px 0 10px",textAlign:"center"},
  textRow:{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"},
  textBox:{flex:1,minWidth:180,display:"flex",flexDirection:"column",gap:5},
  boxLabel:{fontSize:11,color:"#6ba3be",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.5px"},
  textarea:{width:"100%",minHeight:150,padding:"10px",borderRadius:10,border:"1px solid #1e3a5f",background:"#060f1a",color:"#e8f4fd",fontSize:14,resize:"vertical",boxSizing:"border-box",lineHeight:1.6,outline:"none",fontFamily:"inherit"},
  output:{resize:"none",display:"flex",alignItems:"flex-start"},
  actions:{display:"flex",gap:5},
  iconBtn:{padding:"5px 9px",borderRadius:7,border:"1px solid #1e3a5f",background:"transparent",color:"#6ba3be",cursor:"pointer",fontSize:13},
  mainBtn:{width:"100%",padding:"13px",borderRadius:10,border:"none",background:"linear-gradient(90deg,#0099cc,#00d4ff)",color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer"},
  mainBtn2:{padding:"12px 18px",borderRadius:10,border:"none",background:"linear-gradient(90deg,#0099cc,#00d4ff)",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14},
  voiceCenter:{display:"flex",flexDirection:"column",alignItems:"center",gap:20,paddingTop:32},
  micRing:{width:110,height:110,borderRadius:"50%",border:"3px solid #1e3a5f",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.3s"},
  micRingOn:{border:"3px solid #00d4ff",boxShadow:"0 0 28px #00d4ff44"},
  micBtn:{width:84,height:84,borderRadius:"50%",border:"none",background:"#0d1b2a",fontSize:32,cursor:"pointer"},
  micBtnOn:{background:"#00d4ff22"},
  voiceResult:{width:"100%",background:"#060f1a",borderRadius:10,padding:16,border:"1px solid #1e3a5f"},
  speakBtn:{padding:"8px 16px",borderRadius:8,border:"1px solid #00d4ff44",background:"#00d4ff11",color:"#00d4ff",cursor:"pointer",fontSize:13},
  chatBox:{minHeight:280,maxHeight:380,overflowY:"auto",background:"#060f1a",borderRadius:10,border:"1px solid #1e3a5f",padding:14,marginBottom:10,display:"flex",flexDirection:"column",gap:8},
  empty:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:180,color:"#2a4a6a",gap:6},
  msg:{display:"flex"},
  msgUser:{justifyContent:"flex-end"},
  msgBot:{justifyContent:"flex-start"},
  bubble:{maxWidth:"80%",padding:"9px 13px",borderRadius:12,fontSize:13,lineHeight:1.5,background:"#0d1b2a",border:"1px solid #1e3a5f",whiteSpace:"pre-wrap"},
  chatRow:{display:"flex",gap:8},
  chatInput:{flex:1,padding:"11px",borderRadius:9,border:"1px solid #1e3a5f",background:"#060f1a",color:"#e8f4fd",fontSize:13,outline:"none",fontFamily:"inherit"},
};
