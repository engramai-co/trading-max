import assert from "node:assert/strict";
import { test } from "node:test";
import { complete } from "../complete.mjs";

const request = {
  provider: "deepseek", model: "deepseek-v4-flash", apiKey: "synthetic-key",
  baseUrl: "https://provider.example.test", maxRetries: 0, timeoutMs: 1500,
  context: { systemPrompt: "Return JSON.", messages: [{role:"user",content:"fixture",timestamp:1}] },
  json: true,
};
const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
  headers: { "content-type": "text/event-stream" },
});
test("Anthropic uses the native Messages API through Pi", async () => {
  let seen;
  const result = await complete({...request,provider:"anthropic",model:"claude-sonnet-4-6"}, {
    fetch:async (url,init) => {
      seen=JSON.parse(init.body);
      assert.equal(new URL(url).pathname,"/v1/messages");
      assert.equal(new Headers(init.headers).get("x-api-key"),"synthetic-key");
      assert.equal(init.redirect,"error");
      const events=[
        {type:"message_start",message:{id:"fixture",role:"assistant",content:[],model:"claude-sonnet-4-6",usage:{input_tokens:10,output_tokens:0}}},
        {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
        {type:"content_block_delta",index:0,delta:{type:"text_delta",text:'{"ok":true}'}},
        {type:"content_block_stop",index:0},
        {type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:2}},
        {type:"message_stop"},
      ];
      return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
    },
  });
  assert.equal(result.error,undefined);
  assert.equal(result.text,'{"ok":true}');
  assert.equal(seen.model,"claude-sonnet-4-6");
  assert.equal(result.usage.input,10);
});
test("Google uses the native SDK, JSON mode, and restores the fetch boundary", async () => {
  const previous=globalThis.fetch;
  const result=await complete({...request,provider:"google",model:"gemini-2.5-flash",baseUrl:"https://provider.example.test/v1beta"}, {
    fetch:async (url,init) => {
      assert.match(String(url),/models\/gemini-2.5-flash:streamGenerateContent/);
      assert.equal(new Headers(init.headers).get("x-goog-api-key"),"synthetic-key");
      assert.equal(init.redirect,"error");
      const body=JSON.parse(init.body);
      assert.equal(body.generationConfig.responseMimeType,"application/json");
      return sse([{candidates:[{content:{role:"model",parts:[{text:'{"ok":true}'}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12}}]);
    },
  });
  assert.equal(globalThis.fetch,previous);
  assert.equal(result.error,undefined);
  assert.equal(result.text,'{"ok":true}');
  assert.equal(result.usage.totalTokens,12);
});
function chat(text = '{"ok":true}', finish = "stop", delta) {
  return sse([
    { id:"fixture", object:"chat.completion.chunk", model:"fixture", choices:[
      { index:0, delta: delta ?? {role:"assistant",content:text}, finish_reason:null },
    ] },
    { id:"fixture", object:"chat.completion.chunk", choices:[
      { index:0, delta:{}, finish_reason:finish },
    ], usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:3}} },
  ]);
}

for (const provider of ["deepseek", "opencode"]) test(`${provider} uses Pi wire format and saved model ID`, async () => {
  let seen;
  const result = await complete({...request,provider}, {fetch:async (url, init) => {
    seen = JSON.parse(init.body);
    assert.equal(new URL(url).pathname, "/chat/completions");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-key");
    assert.equal(init.redirect, "error");
    return chat();
  }});
  assert.equal(result.error, undefined);
  assert.equal(seen.model, "deepseek-v4-flash");
  assert.equal(seen.stream, true);
  assert.deepEqual(seen.response_format, {type:"json_object"});
  assert.deepEqual(seen.thinking, {type:"disabled"});
  assert.equal(result.text, '{"ok":true}');
  assert.equal(result.usage.input + result.usage.cacheRead, 10);
  assert.equal(result.usage.totalTokens, 12);
});

test("OpenAI strict schema and store=false survive SDK transport", async () => {
  const schema = {type:"object", properties:{ok:{type:"boolean"}}, required:["ok"], additionalProperties:false};
  const item = {id:"msg_fixture",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:'{"ok":true}',annotations:[]}]};
  const result = await complete({...request,provider:"openai",model:"gpt-4.1-mini",schema,baseUrl:"https://provider.example.test/v1"}, {
    fetch:async (url,init) => {
      const body = JSON.parse(init.body);
      assert.equal(new URL(url).pathname,"/v1/responses");
      assert.equal(body.store,false);
      assert.deepEqual(body.text.format,{type:"json_schema",name:"trading_max_synthesis",strict:true,schema});
      return sse([
        {type:"response.created",response:{id:"resp_fixture"}},
        {type:"response.output_item.added",output_index:0,item:{...item,content:[]}},
        {type:"response.output_text.delta",output_index:0,content_index:0,delta:'{"ok":true}'},
        {type:"response.output_item.done",output_index:0,item},
        {type:"response.completed",response:{id:"resp_fixture",status:"completed",output:[item],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}},
      ]);
    },
  });
  assert.equal(result.error,undefined);
  assert.equal(result.text,'{"ok":true}');
  assert.equal(result.usage.totalTokens,12);
});

for (const [status,code] of [[401,"provider_auth_failed"],[429,"provider_rate_limited"],[500,"provider_unavailable"]]) {
  test(`HTTP ${status} becomes a secret-free error`, async () => {
    const result = await complete(request, {fetch:async () => new Response(JSON.stringify({error:{message:"synthetic-key must never leak"}}),{status,headers:{"content-type":"application/json"}})});
    assert.deepEqual(result,{error:code});
  });
}
test("Pi retries once, without a second application retry loop", async () => {
  let calls=0;
  const result = await complete({...request,maxRetries:1}, {fetch:async () => ++calls===1
    ? new Response('{"error":{"message":"busy"}}',{status:429,headers:{"retry-after-ms":"1","content-type":"application/json"}})
    : chat()});
  assert.equal(result.error,undefined);
  assert.equal(calls,2);
});
test("truncated output cannot be accepted as successful research", async () => {
  assert.deepEqual(await complete(request,{fetch:async()=>chat('{"ok":true}',"length")}),{error:"provider_invalid_output"});
});
test("no ambient key or non-HTTPS endpoint is used", async () => {
  const forbidden = async () => { throw new Error("must not call"); };
  process.env.DEEPSEEK_API_KEY="ambient-not-allowed";
  assert.deepEqual(await complete({...request,apiKey:""},{fetch:forbidden}),{error:"provider_not_configured"});
  assert.deepEqual(await complete({...request,baseUrl:"http://provider.example.test"},{fetch:forbidden}),{error:"provider_model_rejected"});
  delete process.env.DEEPSEEK_API_KEY;
});
test("deadline aborts a blocked request", async () => {
  const result = await complete({...request,timeoutMs:40},{fetch:(_url,init)=>new Promise((_,reject)=>{
    const timer=setTimeout(()=>reject(new Error("fixture did not abort")),500);
    init.signal.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("aborted"));},{once:true});
  })});
  assert.deepEqual(result,{error:"provider_unavailable"});
});
test("existing bounded tool call crosses the Pi message boundary", async () => {
  const context = {...request.context,tools:[{name:"websearch",description:"Find company",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}}]};
  const result = await complete({...request,context,toolChoice:"required",json:false},{fetch:async(_url,init)=>{
    const body=JSON.parse(init.body);
    assert.equal(body.tool_choice,"required");
    assert.equal(body.tools[0].function.name,"websearch");
    return chat("","tool_calls",{role:"assistant",tool_calls:[{index:0,id:"call_1",type:"function",function:{name:"websearch",arguments:'{"query":"company"}'}}]});
  }});
  assert.equal(result.message.stopReason,"toolUse");
  assert.deepEqual(result.message.content[0].arguments,{query:"company"});
});
