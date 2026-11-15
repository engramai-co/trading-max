// Historical recorder. Run from the repository root with the previous
// synthesis/_pi/complete.mjs and its locked dependencies present (Pi 0.86.1).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { pathToFileURL } from "node:url";

const { complete } = await import(pathToFileURL(resolve(process.env.PI_COMPLETE ??
  "backend/src/trading_max/synthesis/_pi/complete.mjs")).href);
const token = "e30." + Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": {chatgpt_account_id: "fixture-account"},
})).toString("base64") + ".signature";
const text = '{"ok":true}';
const tool = {name: "websearch", description: "Find company", parameters: {
  type: "object", properties: {query: {type: "string"}}, required: ["query"],
  additionalProperties: false,
}};
const schema = {type: "object", properties: {ok: {type: "boolean"}}, required: ["ok"], additionalProperties: false};
const user = (content) => ({role: "user", content, timestamp: 1});
const models = {
  openai: ["https://api.openai.com/v1", ["gpt-5.6-luna", "gpt-4.1-mini", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4-mini", "gpt-5.4"]],
  "openai-codex": ["https://chatgpt.com/backend-api", ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]],
  anthropic: ["https://api.anthropic.com", ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-fable-5-1", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"]],
  google: ["https://generativelanguage.googleapis.com/v1beta", ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"]],
  deepseek: ["https://api.deepseek.com", ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner", "saved-alias"]],
  opencode: ["https://opencode.ai/zen/go/v1", ["deepseek-v4-flash", "deepseek-v4-pro", "saved-alias"]],
};

function events(provider, mode, model) {
  const isTool = mode === "tool";
  const truncated = mode === "length";
  if (provider === "openai" || provider === "openai-codex") {
    const item = isTool
      ? {id:"fc_fixture", type:"function_call", call_id:"call_1", name:"websearch", arguments:'{"query":"company"}', status:"completed"}
      : {id:"msg_fixture", type:"message", role:"assistant", status:"completed", content:[{type:"output_text",text,annotations:[]}]};
    const response = {id:"resp_fixture", object:"response", created_at:1, status:truncated?"incomplete":"completed", model, output:[item],
      incomplete_details:truncated?{reason:"max_output_tokens"}:null,
      usage:{input_tokens:10,input_tokens_details:{cached_tokens:3},output_tokens:2,output_tokens_details:{reasoning_tokens:0},total_tokens:12}};
    return [
      {type:"response.created", response:{...response,status:"in_progress",output:[]}},
      {type:"response.output_item.added", output_index:0, item:isTool?{...item,arguments:""}:{...item,content:[]}},
      ...(isTool
        ? [{type:"response.function_call_arguments.delta", item_id:item.id, output_index:0, delta:item.arguments}]
        : [{type:"response.content_part.added", item_id:item.id, output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},
           {type:"response.output_text.delta", item_id:item.id, output_index:0,content_index:0,delta:text}]),
      {type:"response.output_item.done", output_index:0, item},
      {type:truncated?"response.incomplete":"response.completed", response},
    ].map((event, sequence_number) => ({...event, sequence_number}));
  }
  if (provider === "anthropic") {
    return [
      {type:"message_start",message:{id:"msg_fixture",type:"message",role:"assistant",content:[],model,
        usage:{input_tokens:7,cache_read_input_tokens:2,cache_creation_input_tokens:1,output_tokens:0}}},
      {type:"content_block_start",index:0,content_block:isTool?{type:"tool_use",id:"call_1",name:"websearch",input:{}}:{type:"text",text:""}},
      {type:"content_block_delta",index:0,delta:isTool?{type:"input_json_delta",partial_json:'{"query":"company"}'}:{type:"text_delta",text}},
      {type:"content_block_stop",index:0},
      {type:"message_delta",delta:{stop_reason:isTool?"tool_use":truncated?"max_tokens":"end_turn",stop_sequence:null},usage:{output_tokens:2}},
      {type:"message_stop"},
    ];
  }
  if (provider === "google") {
    return [{modelVersion:model, candidates:[{content:{role:"model",parts:[isTool?{functionCall:{id:"call_1",name:"websearch",args:{query:"company"}},thoughtSignature:"Zml4dHVyZQ=="}:{text}]},finishReason:truncated?"MAX_TOKENS":"STOP",index:0}],usageMetadata:{promptTokenCount:10,cachedContentTokenCount:3,candidatesTokenCount:2,totalTokenCount:12}}];
  }
  return [
    { id:"fixture", object:"chat.completion.chunk", created:1, model, choices:[
      { index:0, delta: isTool?{role:"assistant",tool_calls:[{index:0,id:"call_1",type:"function",function:{name:"websearch",arguments:'{"query":"company"}'}}]}:{role:"assistant",content:text}, finish_reason:null },
    ] },
    { id:"fixture", object:"chat.completion.chunk", created:1, model, choices:[
      { index:0, delta:{}, finish_reason:isTool?"tool_calls":truncated?"length":"stop" },
    ], usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:3}} },
  ];
}
const sse = (items, named) => items.map((e) => (named?"event: "+e.type+"\n":"")+"data: "+JSON.stringify(e)+"\n\n").join("");
const fixtures = [];
for (const [provider, [baseUrl, ids]] of Object.entries(models)) {
  const cases = [
    ["analyze", {json:true, ...(provider==="openai"?{schema}:{})}, "text"],
    ["json", {json:true}, "text"],
    ["test", {maxTokens:32,temperature:0,context:{messages:[user("Reply with OK.")]}}, "text"],
    ["tool_required", {toolChoice:"required",maxTokens:1200,temperature:0}, "tool"],
    ["tool_result", {toolChoice:"none",json:true,maxTokens:1200,temperature:0}, "text"],
    ["unexpected_tool", {}, "tool"],
    ["forbidden_tool", {toolChoice:"none"}, "tool"],
    ...[400,401,403,429,500].map(status=>["http_"+status,{},status]),
    ["timeout", {timeoutMs:40}, "timeout"],
    ["length", {}, "length"],
  ];
  let toolMessage;
  for (const [modelIndex, model] of ids.entries()) {
    for (const [label, options, mode] of (modelIndex ? [cases[0], cases[3]] : cases)) {
      
      const context = {systemPrompt:"Return JSON for a synthetic company.",messages:[user("Synthetic company")],tools:[]};
      if (["tool_required","tool_result","forbidden_tool"].includes(label)) context.tools=[tool];
      if (label==="tool_result" && toolMessage) {
        context.messages.push(toolMessage, {role:"toolResult",toolCallId:toolMessage.content.find(p=>p.type==="toolCall").id,
          toolName:tool.name,content:[{type:"text",text:"Synthetic search result"}],isError:false,timestamp:1});
      }
      const request = {
        provider,model,baseUrl,apiKey:provider==="openai-codex"?token:"synthetic-key",maxRetries:0,
        timeoutMs:1500,context,...options,
      };
      let wire;
      const stream = typeof mode==="number" || mode==="timeout" ? undefined : sse(events(provider,mode,model),provider==="anthropic");
      const response = await complete(request,{
        fetch:async (input,init) => {
          if (init.redirect!=="error") throw new Error("old redirect guard was not applied");
          const url = new URL(input), headers = new Headers(init.headers);
          wire = {endpoint:url.pathname, search:url.search, body:JSON.parse(headers.get("content-encoding")==="zstd"?zstdDecompressSync(init.body):init.body),
            auth:headers.has("chatgpt-account-id")?"codex-bearer":headers.has("authorization")?"bearer":headers.has("x-api-key")?"x-api-key":"x-goog-api-key",
            stateHeaders:["session-id","thread-id","x-client-request-id"].filter(h=>headers.has(h))};
          if (typeof mode==="number") return new Response(JSON.stringify({error:{message:"sensitive upstream text",type:"error",code:mode,status:"ERROR"}}),{status:mode,headers:{"content-type":"application/json"}});
          if (mode==="timeout") return new Promise((_,reject)=>{
            const hold=setTimeout(()=>reject(new Error("no abort")),500);
            init.signal.addEventListener("abort",()=>{clearTimeout(hold);reject(new Error("aborted"));},{once:true});
          });
          return new Response(stream,{headers:{"content-type":"text/event-stream"}});
        },
      });
      if (label==="tool_required") toolMessage=response.message;
      const { context: sent, apiKey: _, ...shape } = request;
      const result = response.error ? response : {
        text:response.text, usage:Object.fromEntries(["input","output","cacheRead","cacheWrite","totalTokens"].map(k=>[k,response.usage[k]])),
        stop:response.message.stopReason,
        parts:response.message.content.map(({type,text,name,id,thoughtSignature,arguments:args})=>({type,text,name,id,thoughtSignature,arguments:args})),
      };
      // The only response content replayed by the historical resolver is the
      // assistant turn; usage pricing and wall-clock timestamps are not inputs.
      if (sent.messages[1]?.role === "assistant") {
        const {role, content, model, provider} = sent.messages[1];
        sent.messages[1] = {role, content, model, provider, timestamp:1};
      }
      if (!wire) throw new Error("missing baseline: " + provider + "/" + model + "/" + label);
      fixtures.push({label, ...shape, context:sent, wire, mode, stream, result});
    }
  }
}
writeFileSync("backend/tests/fixtures/llm/pi_0_86_1.json", "[\n" + fixtures.map((item) => "  " + JSON.stringify(item)).join(",\n") + "\n]\n");
