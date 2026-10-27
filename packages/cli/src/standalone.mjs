import { CliError, DEFAULT_TIMEOUT_MS } from './client.mjs';

export async function loadSdk() {
  try { return await import('../dist/sdk/index.mjs'); }
  catch(error) {
    if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
    try{return await import('../../sdk/dist/index.mjs');}
    catch{throw new CliError('SDK_BUILD_REQUIRED','Run pnpm --filter @onethu/cli build, or install the built OneTHU CLI package.',2);}
  }
}
export function sdkError(error) {
  if(error instanceof CliError)return error;
  const message=String(error?.message??'CLI_OPERATION_FAILED');
  const code=/^([A-Z][A-Z0-9_]{2,80})(?::|\s|$)/.exec(message)?.[1]??'CLI_OPERATION_FAILED';
  const rainHints={
    YUKETANG_NOT_CONFIGURED:'Sign in to Rain Classroom using Settings > Account > Rain Classroom > QR code, then retry. The desktop app can share that session with this CLI.',
    YUKETANG_SESSION_EXPIRED:'Rain Classroom login expired. Sign in again using Settings > Account > Rain Classroom > QR code. University sign-in is separate.',
    YUKETANG_SESSION_CHANGED:'Rain Classroom login changed during the query. Check yuketang status and retry.',
    YUKETANG_ACCOUNT_MISMATCH:'Sign in to Rain Classroom again for the current university account.',
    YUKETANG_CLASSROOM_NOT_FOUND:'Use a classroom id returned by yuketang courses; Learn course ids are different.',
    YUKETANG_COURSES_UNEXPECTED:'Rain Classroom returned an unexpected course response. Check yuketang status and retry later.',
    YUKETANG_INVALID_DAYS:'Use an integer from 1 to 3660 for the homework day window.',
  };
  // SDK already projects external errors. This adapter exposes stable codes,
  // rather than a network response body or configuration values.
  // TEMP-DIAG (revert before release): surface the reason behind unknown codes.
  if (process.env.ONETHU_DEBUG_SDK_ERROR) console.error('SDK_ERROR_RAW=' + message.slice(0, 200));
  return new CliError(code,rainHints[code]??code.replace(/_/g,' '), /REQUIRED|CONFIRMATION|INVALID|NOT_FOUND|UNKNOWN_OPERATION/.test(code)?2:1);
}
export class StandaloneClient {
  constructor(runtime,options={}){this.runtime=runtime;this.timeout=Number(options.timeout||DEFAULT_TIMEOUT_MS);this.endpoint={origin:'standalone'};}
  async call(method,params){
    try{
      if(method==='service/list')return this.runtime.list();
      if(method==='service/call')return await this.runtime.call({...params,deadlineUnixMs:Date.now()+this.timeout},{source:'local'});
      throw new CliError('UNKNOWN_METHOD','Unknown service method.',2);
    }catch(error){throw sdkError(error);}
  }
  async post(route,message){
    if(route!=='/mcp')throw new CliError('INVALID_PATH','Unsupported protocol path.',2);
    const result=await handleMcp(this.runtime,message);return {contentType:'application/json',text:result?JSON.stringify(result):''};
  }
  async close(){await this.runtime.close();}
}

/** Same operation registry as the CLI. Public MCP never gains local-only
 * configuration/authentication rights from a JSON confirmation property. */
export async function handleMcp(runtime,message,control={}) {
  if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')return {jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}};
  if(!Object.hasOwn(message,'id'))return undefined;
  let result;
  try{
    if(message.method==='initialize')result={protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-06-18',serverInfo:{name:'OneTHU CLI',version:runtime.list().version},capabilities:{tools:{listChanged:false}}};
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools:[
      {name:'onethu_commands',description:'Discover OneTHU campus services, persistent tasks and schemas.',inputSchema:{type:'object',properties:{namespace:{type:'string'}},additionalProperties:false},annotations:{readOnlyHint:true}},
      {name:'onethu_call',description:'Execute a published OneTHU operation. Mutations require device automatic authorization. Tool arguments cannot enable it.',inputSchema:{type:'object',required:['operation'],properties:{operation:{type:'string'},args:{type:'array'},confirm:{type:'boolean'}},additionalProperties:false}},
    ]};
    else if(message.method==='tools/call'){
      try{
        let value;
        if(message.params?.name==='onethu_commands'){
          const catalog=runtime.list('mcp'),namespace=message.params.arguments?.namespace;
          value={...catalog,operations:catalog.operations.filter(op=>!namespace||op.name.startsWith(`${namespace}.`))};
        }else if(message.params?.name==='onethu_call')value=await runtime.call(message.params.arguments,{source:'mcp',signal:control.signal});
        else throw new Error('UNKNOWN_TOOL');
        result={content:[{type:'text',text:JSON.stringify(value)}],isError:false};
      }catch(error){const e=sdkError(error);result={content:[{type:'text',text:JSON.stringify({error:{code:e.code,message:e.message}})}],isError:true};}
    }else return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
    return {jsonrpc:'2.0',id:message.id,result};
  }catch(error){const e=sdkError(error);return {jsonrpc:'2.0',id:message.id,error:{code:-32000,message:e.message,data:{code:e.code}}};}
}
