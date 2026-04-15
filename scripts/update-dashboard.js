const https = require("https");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = process.env.GHL_LOCATION_ID || "KdQ3HwgUyOT2bXhJRwQ3";
const BASE_URL = "services.leadconnectorhq.com";

const SALES_PIPELINES = [
  { id: "baLiY8EDb3rVmYMcZ5od", name: "CHEMICALS", fullName: "SALES - CHEMICALS", color: "#4ade80" },
  { id: "UBW05ZwmhKvdtIQTpMsP", name: "CUSTOM BOXES", fullName: "SALES - CUSTOM BOXES", color: "#60a5fa" },
  { id: "DCVBtlDwTjJbdD0wzYCp", name: "FERTILIZER", fullName: "SALES - FERTILIZER", color: "#f472b6" },
  { id: "x6sDRoJEyGvDGaP3kNLv", name: "GENERAL MERCH", fullName: "SALES - GENERAL MERCH", color: "#c084fc" },
  { id: "I4L8FspzjBWLG91nJrM2", name: "IRRIGATION", fullName: "SALES - IRRIGATION", color: "#facc15" },
  { id: "Ptfft52Stw3Cz8Jxmd2h", name: "MULCH FILM", fullName: "SALES - MULCH FILM", color: "#fb923c" },
  { id: "3zKDcNtA4Aj3PNNhTdy1", name: "ROB's CUSTOM", fullName: "SALES - ROB'S CUSTOM ORDERS", color: "#2dd4bf" },
  { id: "BjmYeazjI8ODKvLJRIDF", name: "BIANCA's ORDERS", fullName: "SALES - BIANCA'S ORDERS", color: "#f59e0b" },
];

const CUSTOM_FIELD_IS_NEW = "oMSSLYDRjcnx8j3tWxU9";
const CUSTOM_FIELD_NOTES = "w7wlP9VMBOH9Hr15pHiZ";

// Will be populated at runtime from GHL API
let STAGE_LOOKUP = {};

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function searchOpportunities(pipelineId, status) {
  const allOpps = [];
  let startAfter = null;
  let startAfterId = null;
  let page = 0;
  const maxPages = 10;

  while (page < maxPages) {
    let url = `/opportunities/search?location_id=${LOCATION_ID}&pipeline_id=${pipelineId}&status=${status}&limit=100`;
    if (startAfter && startAfterId) {
      url += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    }
    const result = await apiRequest(url);
    if (!result.opportunities) break;
    allOpps.push(...result.opportunities);
    if (!result.meta?.nextPage && result.opportunities.length < 100) break;
    startAfter = result.meta?.startAfter;
    startAfterId = result.meta?.startAfterId;
    if (!startAfter || !startAfterId) break;
    page++;
  }
  return allOpps;
}

async function fetchPipelineStages() {
  const result = await apiRequest(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
  const lookup = {};
  if (result.pipelines) {
    result.pipelines.forEach(p => {
      if (p.stages) {
        p.stages.forEach(s => { lookup[s.id] = s.name; });
      }
    });
  }
  return lookup;
}

function extractOpp(opp) {
  const isNewField = opp.customFields?.find((f) => f.id === CUSTOM_FIELD_IS_NEW);
  const notesField = opp.customFields?.find((f) => f.id === CUSTOM_FIELD_NOTES);
  return {
    id: opp.id,
    name: opp.name || "Unnamed",
    company: opp.contact?.companyName || "",
    amount: opp.monetaryValue || 0,
    status: opp.status || "open",
    stage: STAGE_LOOKUP[opp.pipelineStageId] || "Unknown",
    isNew: isNewField?.fieldValueString || null,
    notes: (notesField?.fieldValueString || "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$"),
  };
}

const SNAPSHOT_PATH = path.join(__dirname, "..", "data", "snapshot.json");
const AUDIT_LOG_PATH = path.join(__dirname, "..", "data", "audit-log.json");
const MAX_AUDIT_ENTRIES = 500;

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")); }
  catch { return null; }
}

function loadAuditLog() {
  try { return JSON.parse(fs.readFileSync(AUDIT_LOG_PATH, "utf8")); }
  catch { return []; }
}

function generateAuditEntries(prevSnapshot, newSnapshot, timestamp) {
  if (!prevSnapshot) return [{ date: timestamp, type: "init", message: "Dashboard initialized - first data pull" }];

  const entries = [];
  const prevOpps = {};
  const newOpps = {};

  prevSnapshot.forEach(p => p.opps.forEach(o => { prevOpps[o.id] = { ...o, pipeline: p.pipelineName }; }));
  newSnapshot.forEach(p => p.opps.forEach(o => { newOpps[o.id] = { ...o, pipeline: p.pipelineName }; }));

  // New opportunities
  for (const [id, opp] of Object.entries(newOpps)) {
    if (!prevOpps[id]) {
      entries.push({ date: timestamp, type: "added", pipeline: opp.pipeline, name: opp.name, company: opp.company, amount: opp.amount, status: opp.status, message: `New opportunity: ${opp.name} (${opp.pipeline}) - $${opp.amount.toFixed(2)}` });
    }
  }

  // Removed opportunities
  for (const [id, opp] of Object.entries(prevOpps)) {
    if (!newOpps[id]) {
      entries.push({ date: timestamp, type: "removed", pipeline: opp.pipeline, name: opp.name, company: opp.company, amount: opp.amount, status: opp.status, message: `Removed: ${opp.name} (${opp.pipeline}) - $${opp.amount.toFixed(2)}` });
    }
  }

  // Changed opportunities
  for (const [id, opp] of Object.entries(newOpps)) {
    const prev = prevOpps[id];
    if (!prev) continue;

    if (prev.amount !== opp.amount) {
      const diff = opp.amount - prev.amount;
      const arrow = diff > 0 ? "+" : "";
      entries.push({ date: timestamp, type: "value_change", pipeline: opp.pipeline, name: opp.name, company: opp.company, amount: opp.amount, prevAmount: prev.amount, message: `${opp.name}: value changed $${prev.amount.toFixed(2)} -> $${opp.amount.toFixed(2)} (${arrow}${diff.toFixed(2)})` });
    }

    if (prev.status !== opp.status) {
      entries.push({ date: timestamp, type: "status_change", pipeline: opp.pipeline, name: opp.name, company: opp.company, amount: opp.amount, prevStatus: prev.status, newStatus: opp.status, message: `${opp.name}: status changed ${prev.status} -> ${opp.status}` });
    }

    if (prev.isNew !== opp.isNew) {
      entries.push({ date: timestamp, type: "field_change", pipeline: opp.pipeline, name: opp.name, company: opp.company, amount: opp.amount, message: `${opp.name}: "New Business" changed ${prev.isNew || "Not Set"} -> ${opp.isNew || "Not Set"}` });
    }

    if (prev.name !== opp.name) {
      entries.push({ date: timestamp, type: "renamed", pipeline: opp.pipeline, name: opp.name, company: opp.company, amount: opp.amount, message: `Renamed: "${prev.name}" -> "${opp.name}"` });
    }
  }

  return entries;
}

function escapeForJS(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}

function oppToJS(opp) {
  const isNewStr = opp.isNew ? `"${opp.isNew}"` : "null";
  return `          { name: "${escapeForJS(opp.name)}", company: "${escapeForJS(opp.company)}", amount: ${opp.amount}, stage: "${escapeForJS(opp.stage)}", isNew: ${isNewStr}, notes: "${escapeForJS(opp.notes)}" }`;
}

function pipelineToJS(pipeline, opps) {
  const value = opps.reduce((s, o) => s + o.amount, 0);
  const oppLines = opps.map(oppToJS).join(",\n");
  return `      { name: "${pipeline.name}", fullName: "${pipeline.fullName}", value: ${value}, color: "${pipeline.color}", opportunities: [\n${oppLines}\n      ]}`;
}

function generateHTML(wonData, openData, auditData, updatedDate) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sales Pipeline - Opportunities Dashboard</title>
  <link rel="icon" type="image/png" href="https://assets.cdn.filesafe.space/KdQ3HwgUyOT2bXhJRwQ3/media/697322ce10cc27e2704399a4.png" />
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4e8; min-height: 100vh; padding: 40px 20px; }
    #root { width: 100%; max-width: 1500px; margin: 0 auto; }
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: #1c1f26; border-radius: 4px; }
    ::-webkit-scrollbar-thumb { background: #3d434d; border-radius: 4px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">

    const WON_DATA = [
${wonData}
    ];

    const OPEN_DATA = [
${openData}
    ];

    const AUDIT_LOG = ${auditData};

    function polarToCartesian(cx, cy, r, a) { const rad=((a-90)*Math.PI)/180; return {x:cx+r*Math.cos(rad),y:cy+r*Math.sin(rad)}; }
    function describeArc(cx,cy,r,s,e) { const st=polarToCartesian(cx,cy,r,e),en=polarToCartesian(cx,cy,r,s),l=e-s>180?1:0; return \`M \${cx} \${cy} L \${st.x} \${st.y} A \${r} \${r} 0 \${l} 0 \${en.x} \${en.y} Z\`; }
    function formatCurrency(v) { return "$"+v.toLocaleString("en-AU",{minimumFractionDigits:2,maximumFractionDigits:2}); }

    function NewBadge({isNew}) {
      if (isNew===null) return <span style={{fontSize:10,color:"#484f58",padding:"2px 6px",borderRadius:4,background:"#21262d"}}>--</span>;
      const y=isNew==="Yes";
      return <span style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,background:y?"#16301d":"#2d1b1b",color:y?"#4ade80":"#f87171",border:\`1px solid \${y?"#4ade8030":"#f8717130"}\`}}>{y?"NEW":"EXISTING"}</span>;
    }

    function OppName({opp}) {
      const [show, setShow] = React.useState(false);
      const [pos, setPos] = React.useState({x:0,y:0});
      const handleEnter = (e) => { setShow(true); setPos({x:e.clientX,y:e.clientY}); };
      const handleMove = (e) => { setPos({x:e.clientX,y:e.clientY}); };
      const hasNotes = opp.notes && opp.notes.trim().length > 0;
      return (
        <span onMouseEnter={handleEnter} onMouseMove={handleMove} onMouseLeave={()=>setShow(false)}
          style={{fontSize:13,color:"#e1e4e8",fontWeight:500,cursor:hasNotes?"help":"default",borderBottom:hasNotes?"1px dotted #484f58":"none"}}>
          {opp.name}
          {show && hasNotes && (
            <div style={{position:"fixed",left:Math.min(pos.x+12,window.innerWidth-340),top:pos.y+16,background:"#1c1f26",border:"1px solid #30363d",borderRadius:10,padding:"12px 16px",maxWidth:320,zIndex:9999,pointerEvents:"none",boxShadow:"0 8px 24px rgba(0,0,0,0.6)"}}>
              <div style={{fontSize:11,fontWeight:600,color:"#8b949e",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.05em"}}>Additional Notes</div>
              <div style={{fontSize:12,color:"#e1e4e8",whiteSpace:"pre-wrap",lineHeight:1.5}}>{opp.notes}</div>
            </div>
          )}
        </span>
      );
    }

    function DetailPanel({pipeline,onClose}) {
      if (!pipeline) return (
        <div style={{flex:1,minWidth:260,maxWidth:340,background:"#161920",borderRadius:12,border:"1px solid #21262d",padding:24,display:"flex",alignItems:"center",justifyContent:"center",minHeight:300}}>
          <p style={{color:"#484f58",fontSize:14,textAlign:"center"}}>Click a slice to see<br/>opportunity details</p>
        </div>
      );
      return (
        <div style={{flex:1,minWidth:260,maxWidth:340,background:"#161920",borderRadius:12,border:\`1px solid \${pipeline.color}30\`,padding:0,minHeight:300,maxHeight:500,display:"flex",flexDirection:"column",boxShadow:\`0 0 20px \${pipeline.color}10\`}}>
          <div style={{padding:"16px 18px 12px",borderBottom:\`1px solid \${pipeline.color}25\`,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{width:12,height:12,borderRadius:3,background:pipeline.color}}/>
                <span style={{fontWeight:700,fontSize:14,color:"#fff"}}>{pipeline.fullName}</span>
              </div>
              <span style={{fontSize:20,fontWeight:700,color:pipeline.color}}>{formatCurrency(pipeline.value)}</span>
              <div style={{fontSize:12,color:"#8b949e",marginTop:4}}>{pipeline.opportunities.length} deal{pipeline.opportunities.length!==1?"s":""}</div>
            </div>
            <button onClick={onClose} style={{background:"none",border:"1px solid #30363d",borderRadius:6,color:"#8b949e",cursor:"pointer",fontSize:16,width:28,height:28,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}
              onMouseEnter={e=>e.target.style.borderColor="#fff"} onMouseLeave={e=>e.target.style.borderColor="#30363d"}>x</button>
          </div>
          <div style={{overflowY:"auto",flex:1,padding:"8px 18px 16px"}}>
            {pipeline.opportunities.map((opp,j)=>(
              <div key={j} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",gap:8,borderBottom:j<pipeline.opportunities.length-1?"1px solid #21262d":"none"}}>
                <div style={{minWidth:0,flex:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <OppName opp={opp}/> <NewBadge isNew={opp.isNew}/>
                  </div>
                  {opp.company&&<div style={{fontSize:11,color:"#6e7681",marginTop:2}}>{opp.company}</div>}
                </div>
                <div style={{fontSize:13,fontWeight:600,whiteSpace:"nowrap",color:opp.amount>0?"#fff":"#484f58"}}>{formatCurrency(opp.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    function DonutChart({data,title,subtitle,centerLabel}) {
      const [hovered,setHovered]=React.useState(null);
      const [selected,setSelected]=React.useState(null);
      const active=selected!==null?selected:hovered;
      const total=data.reduce((s,p)=>s+p.value,0);
      const totalOpps=data.reduce((s,p)=>s+p.opportunities.length,0);
      const cx=160,cy=160,radius=140,innerRadius=72;
      let currentAngle=0;
      const slices=data.map((p,i)=>{const angle=(p.value/total)*360;const startAngle=currentAngle;const endAngle=currentAngle+angle;currentAngle=endAngle;return{...p,outerPath:describeArc(cx,cy,active===i?radius+10:radius,startAngle,endAngle),index:i};});
      const handleSliceClick=(i)=>setSelected(selected===i?null:i);
      return (
        <div style={{flex:1,minWidth:520}}>
          <h2 style={{textAlign:"center",fontSize:20,fontWeight:700,marginBottom:4,color:"#fff"}}>{title}</h2>
          <p style={{textAlign:"center",fontSize:13,color:"#8b949e",marginBottom:16}}>{totalOpps} {subtitle} &mdash; {formatCurrency(total)}</p>
          <div style={{display:"flex",gap:20,alignItems:"flex-start",justifyContent:"center"}}>
            <div style={{textAlign:"center"}}>
              <svg viewBox="-10 -10 340 340" width="340" height="340">
                {slices.map(s=><path key={s.index} d={s.outerPath} fill={s.color} stroke="#0f1117" strokeWidth="2" style={{transition:"all 0.2s ease",filter:active===s.index?\`drop-shadow(0 0 14px \${s.color}80)\`:"none",opacity:active!==null&&active!==s.index?0.3:1,cursor:"pointer"}} onMouseEnter={()=>setHovered(s.index)} onMouseLeave={()=>setHovered(null)} onClick={()=>handleSliceClick(s.index)}/>)}
                <circle cx={cx} cy={cy} r={innerRadius} fill="#0f1117"/>
                <text x={cx} y={cy-8} textAnchor="middle" fill="#fff" fontSize="17" fontWeight="700">{formatCurrency(total)}</text>
                <text x={cx} y={cy+12} textAnchor="middle" fill="#8b949e" fontSize="11">{centerLabel}</text>
              </svg>
              <div style={{display:"flex",flexWrap:"wrap",justifyContent:"center",gap:"4px 12px",marginTop:8}}>
                {data.map((p,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:5,padding:"4px 8px",borderRadius:6,background:selected===i?"#1c1f26":hovered===i?"#161920":"transparent",border:selected===i?\`1px solid \${p.color}40\`:"1px solid transparent",cursor:"pointer",transition:"all 0.2s"}} onMouseEnter={()=>setHovered(i)} onMouseLeave={()=>setHovered(null)} onClick={()=>handleSliceClick(i)}>
                  <div style={{width:8,height:8,borderRadius:2,background:p.color}}/><span style={{fontSize:11,color:"#8b949e"}}>{p.name}</span><span style={{fontSize:11,fontWeight:600,color:"#e1e4e8"}}>{formatCurrency(p.value)}</span><span style={{fontSize:10,color:"#6e7681"}}>({p.opportunities.length})</span>
                </div>)}
              </div>
            </div>
            <DetailPanel pipeline={selected!==null?data[selected]:null} onClose={()=>setSelected(null)}/>
          </div>
        </div>
      );
    }

    function BusinessTypeTable({title,allData}) {
      const [filter,setFilter]=React.useState("all");
      const allOpps=[];
      allData.forEach(p=>p.opportunities.forEach(o=>allOpps.push({...o,pipeline:p.name,pipelineColor:p.color})));
      const filtered=filter==="all"?allOpps:filter==="new"?allOpps.filter(o=>o.isNew==="Yes"):filter==="existing"?allOpps.filter(o=>o.isNew==="No"):allOpps.filter(o=>o.isNew===null);
      const totalValue=filtered.reduce((s,o)=>s+o.amount,0);
      const newCount=allOpps.filter(o=>o.isNew==="Yes").length,existingCount=allOpps.filter(o=>o.isNew==="No").length,notSetCount=allOpps.filter(o=>o.isNew===null).length;
      const newValue=allOpps.filter(o=>o.isNew==="Yes").reduce((s,o)=>s+o.amount,0);
      const existingValue=allOpps.filter(o=>o.isNew==="No").reduce((s,o)=>s+o.amount,0);
      const notSetValue=allOpps.filter(o=>o.isNew===null).reduce((s,o)=>s+o.amount,0);
      const btnStyle=(a)=>({padding:"8px 16px",borderRadius:8,border:"1px solid",borderColor:a?"#4ade8050":"#30363d",background:a?"#16301d":"#161920",color:a?"#4ade80":"#8b949e",cursor:"pointer",fontSize:13,fontWeight:a?600:400,transition:"all 0.2s"});
      return (
        <div style={{marginTop:50}}>
          <h2 style={{textAlign:"center",fontSize:20,fontWeight:700,color:"#fff",marginBottom:6}}>{title}</h2>
          <p style={{textAlign:"center",fontSize:13,color:"#6e7681",marginBottom:20}}>Is this newly acquired business?</p>
          <div style={{display:"flex",justifyContent:"center",gap:16,marginBottom:20,flexWrap:"wrap"}}>
            <div style={{background:"#161920",borderRadius:10,padding:"16px 24px",border:"1px solid #16301d",minWidth:180,textAlign:"center"}}>
              <div style={{fontSize:12,color:"#4ade80",fontWeight:600,marginBottom:4}}>NEW BUSINESS</div>
              <div style={{fontSize:22,fontWeight:700,color:"#fff"}}>{newCount}</div>
              <div style={{fontSize:13,color:"#4ade80"}}>{formatCurrency(newValue)}</div>
            </div>
            <div style={{background:"#161920",borderRadius:10,padding:"16px 24px",border:"1px solid #2d1b1b",minWidth:180,textAlign:"center"}}>
              <div style={{fontSize:12,color:"#f87171",fontWeight:600,marginBottom:4}}>EXISTING BUSINESS</div>
              <div style={{fontSize:22,fontWeight:700,color:"#fff"}}>{existingCount}</div>
              <div style={{fontSize:13,color:"#f87171"}}>{formatCurrency(existingValue)}</div>
            </div>
            <div style={{background:"#161920",borderRadius:10,padding:"16px 24px",border:"1px solid #21262d",minWidth:180,textAlign:"center"}}>
              <div style={{fontSize:12,color:"#484f58",fontWeight:600,marginBottom:4}}>NOT SET</div>
              <div style={{fontSize:22,fontWeight:700,color:"#fff"}}>{notSetCount}</div>
              <div style={{fontSize:13,color:"#484f58"}}>{formatCurrency(notSetValue)}</div>
            </div>
          </div>
          <div style={{display:"flex",justifyContent:"center",gap:8,marginBottom:16}}>
            <button onClick={()=>setFilter("all")} style={btnStyle(filter==="all")}>All ({allOpps.length})</button>
            <button onClick={()=>setFilter("new")} style={btnStyle(filter==="new")}>New Business ({newCount})</button>
            <button onClick={()=>setFilter("existing")} style={btnStyle(filter==="existing")}>Existing ({existingCount})</button>
            <button onClick={()=>setFilter("notset")} style={btnStyle(filter==="notset")}>Not Set ({notSetCount})</button>
          </div>
          <div style={{background:"#161920",borderRadius:12,border:"1px solid #21262d",overflow:"hidden",maxWidth:900,margin:"0 auto"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px 120px",padding:"12px 20px",background:"#1c1f26",borderBottom:"1px solid #21262d",fontSize:11,fontWeight:600,color:"#8b949e",textTransform:"uppercase",letterSpacing:"0.05em"}}>
              <span>Opportunity</span><span>Pipeline</span><span>Status</span><span style={{textAlign:"right"}}>Value</span>
            </div>
            <div style={{maxHeight:500,overflowY:"auto"}}>
              {filtered.sort((a,b)=>b.amount-a.amount).map((opp,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px 120px",padding:"10px 20px",borderBottom:"1px solid #21262d",alignItems:"center"}}>
                  <div><OppName opp={opp}/>{opp.company&&<div style={{fontSize:11,color:"#6e7681"}}>{opp.company}</div>}</div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:8,height:8,borderRadius:2,background:opp.pipelineColor}}/><span style={{fontSize:12,color:"#8b949e"}}>{opp.pipeline}</span></div>
                  <NewBadge isNew={opp.isNew}/>
                  <div style={{textAlign:"right",fontSize:13,fontWeight:600,color:opp.amount>0?"#fff":"#484f58"}}>{formatCurrency(opp.amount)}</div>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 100px 120px",padding:"12px 20px",background:"#1c1f26",borderTop:"1px solid #30363d"}}>
              <span style={{fontSize:13,fontWeight:700,color:"#fff"}}>{filtered.length} opportunities</span><span/><span/>
              <span style={{textAlign:"right",fontSize:13,fontWeight:700,color:"#fff"}}>{formatCurrency(totalValue)}</span>
            </div>
          </div>
        </div>
      );
    }

    function StageExplorer({allData, extPipeline, extStage, stageRef}) {
      const [selectedStage, setSelectedStage] = React.useState(null);
      const [selectedPipeline, setSelectedPipeline] = React.useState("all");

      // Apply external filters from search
      React.useEffect(() => {
        if (extPipeline !== undefined) setSelectedPipeline(extPipeline || "all");
        if (extStage !== undefined) setSelectedStage(extStage || null);
      }, [extPipeline, extStage]);

      const allOpps = [];
      allData.forEach(p => p.opportunities.forEach(o => allOpps.push({...o, pipeline: p.name, pipelineFullName: p.fullName, pipelineColor: p.color})));

      // Get unique pipelines
      const pipelines = [...new Set(allData.map(p => p.name))];

      // Filter by pipeline first
      const pipelineFiltered = selectedPipeline === "all" ? allOpps : allOpps.filter(o => o.pipeline === selectedPipeline);

      // Get unique stages from filtered opps
      const stages = [...new Set(pipelineFiltered.map(o => o.stage))].sort();

      // Filter by stage
      const filtered = selectedStage ? pipelineFiltered.filter(o => o.stage === selectedStage) : pipelineFiltered;
      const totalValue = filtered.reduce((s, o) => s + o.amount, 0);

      // Stage counts for badges
      const stageCounts = {};
      pipelineFiltered.forEach(o => { stageCounts[o.stage] = (stageCounts[o.stage] || 0) + 1; });

      return (
        <div ref={stageRef} style={{marginTop:50}}>
          <h2 style={{textAlign:"center",fontSize:20,fontWeight:700,color:"#fff",marginBottom:6}}>Stage Explorer</h2>
          <p style={{textAlign:"center",fontSize:13,color:"#6e7681",marginBottom:20}}>Find opportunities by pipeline stage</p>

          {/* Pipeline filter */}
          <div style={{display:"flex",justifyContent:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            <button onClick={()=>{setSelectedPipeline("all");setSelectedStage(null);}} style={{padding:"6px 14px",borderRadius:8,border:"1px solid",borderColor:selectedPipeline==="all"?"#60a5fa50":"#30363d",background:selectedPipeline==="all"?"#1a2332":"#161920",color:selectedPipeline==="all"?"#60a5fa":"#8b949e",cursor:"pointer",fontSize:12,fontWeight:selectedPipeline==="all"?600:400}}>All Pipelines</button>
            {pipelines.map(p => {
              const pData = allData.find(d => d.name === p);
              return <button key={p} onClick={()=>{setSelectedPipeline(p);setSelectedStage(null);}} style={{padding:"6px 14px",borderRadius:8,border:"1px solid",borderColor:selectedPipeline===p?pData.color+"50":"#30363d",background:selectedPipeline===p?"#1c1f26":"#161920",color:selectedPipeline===p?pData.color:"#8b949e",cursor:"pointer",fontSize:12,fontWeight:selectedPipeline===p?600:400}}>{p}</button>;
            })}
          </div>

          {/* Stage buttons */}
          <div style={{display:"flex",justifyContent:"center",gap:8,marginBottom:20,flexWrap:"wrap"}}>
            <button onClick={()=>setSelectedStage(null)} style={{padding:"6px 14px",borderRadius:8,border:"1px solid",borderColor:!selectedStage?"#facc1550":"#30363d",background:!selectedStage?"#2d2a14":"#161920",color:!selectedStage?"#facc15":"#8b949e",cursor:"pointer",fontSize:12,fontWeight:!selectedStage?600:400}}>
              All Stages ({pipelineFiltered.length})
            </button>
            {stages.map(stage => (
              <button key={stage} onClick={()=>setSelectedStage(stage)} style={{padding:"6px 14px",borderRadius:8,border:"1px solid",borderColor:selectedStage===stage?"#facc1550":"#30363d",background:selectedStage===stage?"#2d2a14":"#161920",color:selectedStage===stage?"#facc15":"#8b949e",cursor:"pointer",fontSize:12,fontWeight:selectedStage===stage?600:400}}>
                {stage} ({stageCounts[stage]||0})
              </button>
            ))}
          </div>

          {/* Results table */}
          <div style={{background:"#161920",borderRadius:12,border:"1px solid #21262d",overflow:"hidden",maxWidth:1000,margin:"0 auto"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 130px 140px 100px 110px",padding:"12px 20px",background:"#1c1f26",borderBottom:"1px solid #21262d",fontSize:11,fontWeight:600,color:"#8b949e",textTransform:"uppercase",letterSpacing:"0.05em"}}>
              <span>Opportunity</span><span>Pipeline</span><span>Stage</span><span>Status</span><span style={{textAlign:"right"}}>Value</span>
            </div>
            <div style={{maxHeight:450,overflowY:"auto"}}>
              {filtered.sort((a,b)=>b.amount-a.amount).map((opp,i) => (
                <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 130px 140px 100px 110px",padding:"10px 20px",borderBottom:"1px solid #21262d",alignItems:"center"}}>
                  <div>
                    <OppName opp={opp}/>
                    {opp.company && <div style={{fontSize:11,color:"#6e7681"}}>{opp.company}</div>}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:8,height:8,borderRadius:2,background:opp.pipelineColor}}/>
                    <span style={{fontSize:12,color:"#8b949e"}}>{opp.pipeline}</span>
                  </div>
                  <span style={{fontSize:12,color:"#e1e4e8"}}>{opp.stage}</span>
                  <NewBadge isNew={opp.isNew}/>
                  <div style={{textAlign:"right",fontSize:13,fontWeight:600,color:opp.amount>0?"#fff":"#484f58"}}>{formatCurrency(opp.amount)}</div>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 130px 140px 100px 110px",padding:"12px 20px",background:"#1c1f26",borderTop:"1px solid #30363d"}}>
              <span style={{fontSize:13,fontWeight:700,color:"#fff"}}>{filtered.length} opportunities</span><span/><span/><span/>
              <span style={{textAlign:"right",fontSize:13,fontWeight:700,color:"#fff"}}>{formatCurrency(totalValue)}</span>
            </div>
          </div>
        </div>
      );
    }

    const AUDIT_ICONS = { added: "+", removed: "-", value_change: "$", status_change: "~", field_change: "F", renamed: "R", init: "i" };
    const AUDIT_COLORS = { added: "#4ade80", removed: "#f87171", value_change: "#60a5fa", status_change: "#facc15", field_change: "#c084fc", renamed: "#fb923c", init: "#8b949e" };

    function AuditLog() {
      const [expanded, setExpanded] = React.useState(false);
      if (!AUDIT_LOG || AUDIT_LOG.length === 0) return null;

      const grouped = {};
      AUDIT_LOG.forEach(e => {
        const day = new Date(e.date).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
        if (!grouped[day]) grouped[day] = [];
        grouped[day].push(e);
      });
      const days = Object.keys(grouped);
      const displayDays = expanded ? days : days.slice(0, 5);

      return (
        <div style={{marginTop:50}}>
          <h2 style={{textAlign:"center",fontSize:20,fontWeight:700,color:"#fff",marginBottom:6}}>Change Log</h2>
          <p style={{textAlign:"center",fontSize:13,color:"#6e7681",marginBottom:20}}>What changed between each daily update</p>
          <div style={{background:"#161920",borderRadius:12,border:"1px solid #21262d",maxWidth:900,margin:"0 auto",padding:"0"}}>
            {displayDays.map((day, di) => (
              <div key={day}>
                <div style={{padding:"12px 20px",background:"#1c1f26",borderBottom:"1px solid #21262d",borderTop:di>0?"1px solid #21262d":"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:13,fontWeight:700,color:"#e1e4e8"}}>{day}</span>
                  <span style={{fontSize:12,color:"#6e7681"}}>{grouped[day].length} change{grouped[day].length!==1?"s":""}</span>
                </div>
                {grouped[day].map((entry, i) => (
                  <div key={i} style={{padding:"8px 20px",borderBottom:"1px solid #161920",display:"flex",alignItems:"flex-start",gap:10}}>
                    <div style={{width:22,height:22,borderRadius:6,background:AUDIT_COLORS[entry.type]+"20",color:AUDIT_COLORS[entry.type],display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0,marginTop:1}}>
                      {AUDIT_ICONS[entry.type]}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,color:"#e1e4e8"}}>{entry.message}</div>
                      {entry.pipeline && <span style={{fontSize:10,color:"#484f58"}}>{entry.pipeline}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {days.length > 5 && (
              <div style={{padding:"12px 20px",textAlign:"center",borderTop:"1px solid #21262d"}}>
                <button onClick={()=>setExpanded(!expanded)} style={{background:"none",border:"1px solid #30363d",borderRadius:6,color:"#8b949e",cursor:"pointer",fontSize:12,padding:"6px 16px"}}>
                  {expanded ? "Show less" : \`Show all \${days.length} days\`}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    function SearchBar({allData, onSelect, stageRef}) {
      const [query, setQuery] = React.useState("");
      const [focused, setFocused] = React.useState(false);
      const inputRef = React.useRef(null);

      const allOpps = React.useMemo(() => {
        const list = [];
        allData.forEach(p => p.opportunities.forEach(o => list.push({...o, pipeline: p.name, pipelineColor: p.color})));
        return list;
      }, [allData]);

      const results = React.useMemo(() => {
        if (!query || query.length < 2) return [];
        const q = query.toLowerCase();
        return allOpps.filter(o =>
          o.name.toLowerCase().includes(q) ||
          (o.company && o.company.toLowerCase().includes(q)) ||
          o.pipeline.toLowerCase().includes(q) ||
          o.stage.toLowerCase().includes(q)
        ).slice(0, 12);
      }, [query, allOpps]);

      const handleSelect = (opp) => {
        setQuery("");
        setFocused(false);
        inputRef.current?.blur();
        onSelect(opp.pipeline, opp.stage);
        setTimeout(() => { stageRef.current?.scrollIntoView({behavior:"smooth",block:"start"}); }, 100);
      };

      return (
        <div style={{position:"relative",maxWidth:600,margin:"0 auto 40px",zIndex:50}}>
          <div style={{position:"relative"}}>
            <input ref={inputRef} type="text" value={query} placeholder="Search opportunities by name, company, pipeline, or stage..."
              onChange={e=>setQuery(e.target.value)} onFocus={()=>setFocused(true)} onBlur={()=>setTimeout(()=>setFocused(false),200)}
              style={{width:"100%",padding:"12px 16px 12px 42px",borderRadius:10,border:"1px solid #30363d",background:"#161920",color:"#e1e4e8",fontSize:14,outline:"none",transition:"border-color 0.2s",borderColor:focused?"#60a5fa":"#30363d"}}
            />
            <svg style={{position:"absolute",left:14,top:13,width:16,height:16}} viewBox="0 0 24 24" fill="none" stroke="#6e7681" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          </div>
          {focused && results.length > 0 && (
            <div style={{position:"absolute",top:"100%",left:0,right:0,marginTop:4,background:"#1c1f26",border:"1px solid #30363d",borderRadius:10,overflow:"hidden",boxShadow:"0 8px 24px rgba(0,0,0,0.5)"}}>
              {results.map((opp, i) => (
                <div key={i} onMouseDown={()=>handleSelect(opp)} style={{padding:"10px 16px",cursor:"pointer",borderBottom:i<results.length-1?"1px solid #21262d":"none",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}
                  onMouseEnter={e=>e.currentTarget.style.background="#21262d"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,color:"#e1e4e8",fontWeight:500}}>{opp.name}</div>
                    <div style={{fontSize:11,color:"#6e7681",display:"flex",gap:8,marginTop:2}}>
                      {opp.company && <span>{opp.company}</span>}
                      <span style={{display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:2,background:opp.pipelineColor,display:"inline-block"}}/>{opp.pipeline}</span>
                      <span style={{color:"#484f58"}}>{opp.stage}</span>
                    </div>
                  </div>
                  <span style={{fontSize:13,fontWeight:600,color:opp.amount>0?"#fff":"#484f58",whiteSpace:"nowrap"}}>{formatCurrency(opp.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {focused && query.length >= 2 && results.length === 0 && (
            <div style={{position:"absolute",top:"100%",left:0,right:0,marginTop:4,background:"#1c1f26",border:"1px solid #30363d",borderRadius:10,padding:"16px",textAlign:"center"}}>
              <span style={{color:"#484f58",fontSize:13}}>No opportunities found for "{query}"</span>
            </div>
          )}
        </div>
      );
    }

    function Dashboard() {
      const [extPipeline, setExtPipeline] = React.useState(undefined);
      const [extStage, setExtStage] = React.useState(undefined);
      const stageRef = React.useRef(null);

      const handleSearchSelect = (pipeline, stage) => {
        setExtPipeline(pipeline);
        setExtStage(stage);
      };

      return (
        <div>
          <h1 style={{textAlign:"center",fontSize:28,fontWeight:800,color:"#fff",marginBottom:4}}>Sales Pipeline Dashboard</h1>
          <p style={{textAlign:"center",fontSize:14,color:"#6e7681",marginBottom:20}}>CGA Growers Association &mdash; Updated ${updatedDate}</p>
          <SearchBar allData={OPEN_DATA} onSelect={handleSearchSelect} stageRef={stageRef}/>
          <div style={{display:"flex",gap:50,flexWrap:"wrap",justifyContent:"center"}}>
            <DonutChart data={WON_DATA} title="Won Opportunities" subtitle="deals closed" centerLabel="Total Won"/>
            <DonutChart data={OPEN_DATA} title="Open Opportunities" subtitle="deals in progress" centerLabel="Total Open"/>
          </div>
          <BusinessTypeTable title="Open Opportunities - New vs Existing Business" allData={OPEN_DATA}/>
          <StageExplorer allData={OPEN_DATA} extPipeline={extPipeline} extStage={extStage} stageRef={stageRef}/>
          <AuditLog />
        </div>
      );
    }

    ReactDOM.createRoot(document.getElementById("root")).render(<Dashboard />);
  <\/script>
</body>
</html>`;
}

async function main() {
  if (!API_KEY) {
    console.error("ERROR: GHL_API_KEY environment variable not set");
    process.exit(1);
  }

  console.log("Fetching pipeline stages from GHL...");
  STAGE_LOOKUP = await fetchPipelineStages();
  console.log(`  Loaded ${Object.keys(STAGE_LOOKUP).length} stage definitions`);

  console.log("Fetching pipeline data from GHL...");

  const wonPipelines = [];
  const openPipelines = [];

  for (const pipeline of SALES_PIPELINES) {
    console.log(`  ${pipeline.fullName}...`);

    const [openOpps, wonOpps] = await Promise.all([
      searchOpportunities(pipeline.id, "open"),
      searchOpportunities(pipeline.id, "won"),
    ]);

    const openExtracted = openOpps.map(extractOpp);
    const wonExtracted = wonOpps.map(extractOpp);

    if (openExtracted.length > 0) {
      openPipelines.push({ pipeline, opps: openExtracted });
    }
    if (wonExtracted.length > 0) {
      wonPipelines.push({ pipeline, opps: wonExtracted });
    }

    console.log(`    Open: ${openExtracted.length} | Won: ${wonExtracted.length}`);
  }

  // Sort by value descending
  openPipelines.sort((a, b) => {
    const aVal = a.opps.reduce((s, o) => s + o.amount, 0);
    const bVal = b.opps.reduce((s, o) => s + o.amount, 0);
    return bVal - aVal;
  });
  wonPipelines.sort((a, b) => {
    const aVal = a.opps.reduce((s, o) => s + o.amount, 0);
    const bVal = b.opps.reduce((s, o) => s + o.amount, 0);
    return bVal - aVal;
  });

  // --- Audit Log ---
  const now = new Date();
  const timestamp = now.toISOString();
  const allNewData = [
    ...openPipelines.map(p => ({ pipelineName: p.pipeline.name, status: "open", opps: p.opps })),
    ...wonPipelines.map(p => ({ pipelineName: p.pipeline.name, status: "won", opps: p.opps })),
  ];

  const prevSnapshot = loadSnapshot();
  const auditEntries = generateAuditEntries(prevSnapshot, allNewData, timestamp);
  const existingLog = loadAuditLog();
  const updatedLog = [...auditEntries, ...existingLog].slice(0, MAX_AUDIT_ENTRIES);

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(allNewData, null, 2));
  fs.writeFileSync(AUDIT_LOG_PATH, JSON.stringify(updatedLog, null, 2));
  console.log(`  Audit: ${auditEntries.length} changes detected`);

  // --- Build HTML ---
  const wonJS = wonPipelines.map((p) => pipelineToJS(p.pipeline, p.opps)).join(",\n");
  const openJS = openPipelines.map((p) => pipelineToJS(p.pipeline, p.opps)).join(",\n");
  const auditJS = JSON.stringify(updatedLog.slice(0, 200));

  const updatedDate = now.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

  const html = generateHTML(wonJS, openJS, auditJS, updatedDate);

  const outputPath = path.join(__dirname, "..", "index.html");
  fs.writeFileSync(outputPath, html);

  const totalOpen = openPipelines.reduce((s, p) => s + p.opps.length, 0);
  const totalWon = wonPipelines.reduce((s, p) => s + p.opps.length, 0);
  const totalOpenValue = openPipelines.reduce((s, p) => s + p.opps.reduce((ss, o) => ss + o.amount, 0), 0);
  const totalWonValue = wonPipelines.reduce((s, p) => s + p.opps.reduce((ss, o) => ss + o.amount, 0), 0);

  console.log(`\\nDashboard updated: ${outputPath}`);
  console.log(`  Open: ${totalOpen} opportunities worth $${totalOpenValue.toFixed(2)}`);
  console.log(`  Won:  ${totalWon} opportunities worth $${totalWonValue.toFixed(2)}`);
  console.log(`  Date: ${updatedDate}`);
}

main().catch((err) => {
  console.error("Failed to update dashboard:", err);
  process.exit(1);
});
