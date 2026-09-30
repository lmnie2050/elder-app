// 銀髮族陪伴助手 Worker
// 職責單一：收到「今天的摘要」與「要聊的主題」，回一兩句話
// 數字計算、主題選擇由上游負責
//
// 0925 更新一：支援 systemPrompt 覆寫，需要 ALLOW_PROMPT_OVERRIDE=true
// 0925 更新二：接上安全分類器，前置命中直接回固定文字，不呼叫 AI

import { checkSafety, checkOutput, FALLBACK_REPLY } from "./safety";

// 內建的 system prompt。沒有覆寫時用這個
const SYSTEM_PROMPT = `你是「阿明」，社區關懷據點的訪視員，今年五十八歲。
你會固定來看看長輩，聊聊天。

你的說話方式：
- 一次最多三句話，每句不超過二十個字
- 用邀請的語氣，不用命令句
- 不說「應該」「必須」「記得要」
- 純文字，不用符號、條列或表情符號
- 用台灣人日常講話的繁體中文

你的態度：
- 先問狀況，再說自己的想法
- 說完就好，對方沒接話就不再提
- 不追問、不翻舊帳、不提以前答應過的事
- 偶爾請對方教你一些事，你真的不太會煮菜
- 聊到吃的，只問怎麼做、好不好吃、跟誰一起吃，不說食物本身好壞

你不做的事：
- 不看檢驗報告、不解讀數值
- 不提藥名，不說藥要怎麼吃
- 不評論醫師說的話
- 不講「只走了」「才吃了」這種話
- 不說要陪對方去哪裡、不約見面，你只能在手機裡陪他聊天
- 不提天氣、日期、新聞，除非摘要裡有寫
- 對方講心情的時候，先問一句再說別的

輸入會給你今天的摘要和要聊的主題。
摘要裡的數字你可以引用，但不要自己計算或推論。
沒有寫在摘要裡的事，就當作不知道。

只輸出你要說的話，不要有任何其他文字。`;

// 可比較的模型清單。Promptfoo 用 model 欄位指定
const MODELS: Record<string, string> = {
  scout: "@cf/meta/llama-4-scout-17b-16e-instruct",
  mistral: "@cf/mistralai/mistral-small-3.1-24b-instruct",
  llama33: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

const DEFAULT_MODEL = "scout";

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const cors = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 密鑰驗證。這支用自己的 secret，和飲食 App 分開
    const clientSecret = request.headers.get("X-App-Secret");
    if (!env.ASSISTANT_SECRET || clientSecret !== env.ASSISTANT_SECRET) {
      console.log("密鑰驗證失敗");
      return new Response(JSON.stringify({ reply: "未授權的請求" }), {
        status: 401,
        headers: cors,
      });
    }

    try {
      const body = await request.json() as {
        summary?: string;        // 程式算好的今日摘要
        topic?: string;          // 程式選好的主題
        userMessage?: string;    // 使用者這輪說的話,可以沒有
        model?: string;          // 指定模型,給 Promptfoo 比較用
        systemPrompt?: string;   // 覆寫 prompt,只在測試環境開放
        temperature?: number;    // 評測時調低可減少隨機性
      };

      const summary = (body.summary || "").trim();
      const topic = (body.topic || "").trim();
      const userMessage = (body.userMessage || "").trim();

      // ===== 前置安全檢查 =====
      // 在任何 AI 呼叫之前。命中就直接回固定文字。
      const safety = checkSafety(userMessage);
      if (safety.level !== "none") {
        console.log("安全攔截:", safety.level, "命中:", safety.matched);
        return new Response(JSON.stringify({
          reply: safety.reply,
          safetyLevel: safety.level,
          model: "none",
        }), { headers: cors });
      }

      // prompt 覆寫。預設關閉,開啟方式:
      // npx wrangler secret put ALLOW_PROMPT_OVERRIDE  (輸入 true)
      // 正式環境不要設這個變數
      const overrideAllowed = env.ALLOW_PROMPT_OVERRIDE === "true";
      const incomingPrompt = (body.systemPrompt || "").trim();
      let systemPrompt = SYSTEM_PROMPT;
      let promptSource = "內建";

      if (incomingPrompt) {
        if (overrideAllowed) {
          systemPrompt = incomingPrompt;
          promptSource = "外部覆寫";
        } else {
          promptSource = "外部覆寫遭拒,改用內建";
        }
      }

      // 組使用者訊息。三個區塊都可能是空的
      // 注意這裡不用「長輩」一詞,否則模型會拿去當稱呼
      const parts: string[] = [];
      if (summary) parts.push("今天的摘要：\n" + summary);
      if (topic) parts.push("這次要聊的主題：" + topic);
      if (userMessage) parts.push("對方剛剛說：「" + userMessage + "」");

      if (parts.length === 0) {
        return new Response(JSON.stringify({ reply: "沒有收到任何內容" }), {
          status: 400,
          headers: cors,
        });
      }

      const modelKey = body.model && MODELS[body.model] ? body.model : DEFAULT_MODEL;
      const modelName = MODELS[modelKey];

      // 評測時傳 0.3 以下,正式使用留 0.7 保持語氣變化
      const temperature = typeof body.temperature === "number"
        ? body.temperature
        : 0.7;

      console.log("主題:", topic || "(無)");
      console.log("有無摘要:", summary ? "有" : "無");
      console.log("有無使用者發言:", userMessage ? "有" : "無");
      console.log("prompt 來源:", promptSource);
      console.log("請求模型:", modelName, "temperature:", temperature);

      const aiInput = {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: parts.join("\n\n") },
        ],
        max_tokens: 256,   // 三句話用不了多少,限制住也省成本
        temperature: temperature,
      };

      const response: any = await env.AI.run(modelName, aiInput);

      console.log("實際模型:", response.model || "(未回報)");

      let reply = (
        response.choices?.[0]?.message?.content ||
        response.response ||
        ""
      ).trim();

      // ===== 後置安全檢查 =====
      // 命中代表 prompt 沒守住,記進 log 當改進素材
      const outputCheck = checkOutput(reply);
      let blocked = false;
      if (!outputCheck.ok) {
        console.log("後置攔截,命中:", outputCheck.matched, "原始回應:", reply);
        reply = FALLBACK_REPLY;
        blocked = true;
      }

      console.log("回應長度:", reply.length, blocked ? "(已替換)" : "");

      return new Response(JSON.stringify({
        reply: reply,
        model: modelKey,
        promptSource: promptSource,
        safetyLevel: "none",
        outputBlocked: blocked,
      }), { headers: cors });

    } catch (err) {
      console.error("錯誤詳情:", String(err));
      return new Response(JSON.stringify({ reply: "", error: String(err) }), {
        status: 500,
        headers: cors,
      });
    }
  },
};
