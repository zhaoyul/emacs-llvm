import test from "node:test";
import assert from "node:assert/strict";
import { buildDriverEnvironment, environmentDisclosure } from "../src/environment.mjs";
test("baseline strips Emacs and MCP variables",()=>{const env=buildDriverEnvironment({baseEnv:{PATH:"/bin",EMACS_OPERATOR_MCP_CONFIG:"x",MCP_TOKEN:"y",API_KEY:"z"},secretEnvNames:["API_KEY"],additions:{EMACS_OPERATOR_AGENT_MODE:"baseline"},baseline:true});assert.equal(env.PATH,"/bin");assert.equal(env.API_KEY,"z");assert.equal(env.EMACS_OPERATOR_MCP_CONFIG,undefined);assert.equal(env.EMACS_OPERATOR_AGENT_MODE,undefined);assert.equal(env.MCP_TOKEN,undefined);});
test("environment disclosure never includes values",()=>{const rows=environmentDisclosure({PATH:"/bin",OPENAI_API_KEY:"secret"});assert.deepEqual(rows,[{name:"OPENAI_API_KEY",sensitive:true},{name:"PATH",sensitive:false}]);});
