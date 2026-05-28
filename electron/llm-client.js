const https = require('https')
const http = require('http')
const { URL } = require('url')

class LLMClient {
  constructor(baseUrl = 'https://api.openai.com/v1', apiKey = '', model = 'gpt-4o') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
  }

  /**
   * Generate a storyboard from user prompt
   * @param {string} userPrompt - The story/theme from user
   * @param {number} sceneCount - Number of scenes to generate
   * @returns {Promise<Scene[]>}
   */
  async generateStoryboard(userPrompt, sceneCount = 4) {
    const systemPrompt = `你是一位专业的漫画/短视频分镜设计师。
用户会给你一个故事主题或描述，你需要将其分解为 ${sceneCount} 个分镜场景。

请严格按照以下 JSON 格式输出，不要添加任何其他内容：
{
  "title": "故事标题",
  "scenes": [
    {
      "id": 1,
      "description": "本分镜的故事描述（中文，1-2句话）",
      "image_prompt": "Image generation prompt in English, detailed visual description for AI image generation, cinematic style, high quality",
      "video_prompt": "Video motion prompt in English, describe camera movement and action, cinematic, smooth motion"
    }
  ]
}

要求：
- image_prompt 用英文，要详细描述画面内容、光线、构图、风格
- video_prompt 用英文，要描述镜头运动和画面动态
- 每个分镜要有独特性和连贯性
- 分镜数量必须是 ${sceneCount} 个`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]

    const responseText = await this._chat(messages)

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('LLM did not return valid JSON storyboard')
    }

    const parsed = JSON.parse(jsonMatch[0])
    return parsed
  }

  /**
   * Simple chat completion
   */
  async chat(messages) {
    return this._chat(messages)
  }

  /**
   * Test connection to LLM API
   */
  async testConnection() {
    try {
      const result = await this._chat([
        { role: 'user', content: 'Say "OK" and nothing else.' }
      ])
      return { success: true, response: result.trim() }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  // ─── Private ───────────────────────────────────────────────────

  async _chat(messages) {
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: 0.7,
      max_tokens: 4096,
    })

    const url = new URL(`${this.baseUrl}/chat/completions`)

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }

      const lib = url.protocol === 'https:' ? https : http
      const req = lib.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.error) {
              reject(new Error(json.error.message || JSON.stringify(json.error)))
              return
            }
            const content = json.choices?.[0]?.message?.content
            if (!content) {
              reject(new Error('Empty response from LLM: ' + data))
              return
            }
            resolve(content)
          } catch (e) {
            reject(new Error('Failed to parse LLM response: ' + data))
          }
        })
      })

      req.on('error', reject)
      req.setTimeout(60000, () => {
        req.destroy()
        reject(new Error('LLM request timed out (60s)'))
      })
      req.write(body)
      req.end()
    })
  }
}

module.exports = LLMClient
