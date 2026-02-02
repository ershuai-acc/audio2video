import express from 'express'
import multer from 'multer'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createHmac, randomBytes } from 'crypto'
import { execSync, exec } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))
app.use('/outputs', express.static(path.join(__dirname, 'outputs')))

// 文件上传配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'))
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`
    cb(null, uniqueName)
  }
})
const upload = multer({ storage })

// 读取凭据
function loadCredentials() {
  // 优先读取当前目录，其次上级目录
  let envPath = path.join(__dirname, '.piebox', 'env')
  if (!fs.existsSync(envPath)) {
    envPath = path.join(__dirname, '..', '.piebox', 'env')
  }
  if (!fs.existsSync(envPath)) {
    throw new Error('凭据文件不存在，请先运行 create-app')
  }
  const envContent = fs.readFileSync(envPath, 'utf-8')
  const env = {}
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=')
    if (key && value) env[key.trim()] = value.trim()
  })
  return env
}

// HMAC 签名
function generateAuthHeaders(method, apiPath, appId, appSecret) {
  const timestamp = Math.floor(Date.now() / 1000)
  const nonce = randomBytes(16).toString('hex')
  const signatureString = `${method}\n${apiPath}\n${timestamp}\n${nonce}\n${appId}`
  const signature = createHmac('sha256', appSecret).update(signatureString).digest('hex')
  
  return {
    'X-App-Id': appId,
    'X-Timestamp': timestamp.toString(),
    'X-Nonce': nonce,
    'Authorization': `HMAC-SHA256 ${signature}`
  }
}

// API: 上传音频
app.post('/api/upload', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传文件' })
  }
  
  // 从文件名提取标题
  let title = path.basename(req.file.originalname, path.extname(req.file.originalname))
  // 清理文件名中的数字前缀和特殊字符
  title = title.replace(/^\d+[-_]?/, '').replace(/[-_]/g, ' ').trim()
  
  res.json({
    success: true,
    file: {
      filename: req.file.filename,
      originalname: req.file.originalname,
      path: `/uploads/${req.file.filename}`,
      fullPath: req.file.path,
      title: title
    }
  })
})

// API: 语音识别 (ASR)
app.post('/api/asr', async (req, res) => {
  const { audioPath } = req.body
  
  try {
    const credentials = loadCredentials()
    const fullPath = path.join(__dirname, audioPath)
    
    if (!fs.existsSync(fullPath)) {
      return res.status(400).json({ error: '音频文件不存在' })
    }
    
    const audioBuffer = fs.readFileSync(fullPath)
    const audioData = audioBuffer.toString('base64')
    
    const apiPath = '/asr/volcengine_quick'
    const headers = generateAuthHeaders('POST', apiPath, credentials.PIE_APP_ID, credentials.PIE_APP_SECRET)
    
    const response = await fetch(credentials.PIE_GATEWAY_PATH + apiPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify({
        audio_data: audioData,
        enable_punc: true,
        enable_itn: true
      })
    })
    
    if (!response.ok) {
      const error = await response.text()
      throw new Error(`ASR 请求失败: ${response.status} - ${error}`)
    }
    
    const result = await response.json()
    
    // 生成 SRT 字幕
    const srtContent = generateSRT(result.data.utterances)
    const srtFilename = path.basename(audioPath, path.extname(audioPath)) + '.srt'
    const srtPath = path.join(__dirname, 'outputs', srtFilename)
    fs.writeFileSync(srtPath, srtContent)
    
    res.json({
      success: true,
      text: result.data.text,
      duration: result.data.duration,
      utterances: result.data.utterances,
      srtPath: `/outputs/${srtFilename}`
    })
  } catch (error) {
    console.error('ASR Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 生成 SRT 字幕
function generateSRT(utterances) {
  let srtContent = ''
  let index = 1
  
  for (const utterance of utterances) {
    const startTime = msToSrtTime(utterance.start_time)
    const endTime = msToSrtTime(utterance.end_time)
    const text = utterance.text.trim()
    
    if (text) {
      srtContent += `${index}\n`
      srtContent += `${startTime} --> ${endTime}\n`
      srtContent += `${text}\n\n`
      index++
    }
  }
  
  return srtContent
}

function msToSrtTime(ms) {
  if (ms < 0) ms = 0
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const milliseconds = ms % 1000
  
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds.toString().padStart(3, '0')}`
}

// API: 生成封面图片
app.post('/api/generate-cover', async (req, res) => {
  const { title, customPrompt, aspectRatio = '9:16' } = req.body
  
  try {
    // 根据比例设置不同的提示词，包含具体尺寸要求
    const orientationDesc = aspectRatio === '9:16' 
      ? 'vertical 9:16 portrait orientation (1080x1920 pixels)' 
      : 'horizontal 16:9 landscape orientation (1920x1080 pixels)'
    
    const prompt = customPrompt || `Cute kawaii cartoon illustration, ${orientationDesc}. A cheerful scene depicting: ${title}. Adorable chibi-style characters with big sparkling eyes. Flat design style with soft pastel colors, clean lines, and a cozy warm atmosphere. No text in the image.`
    
    const outputName = `cover-${Date.now()}`
    const outputDir = path.join(__dirname, 'outputs', 'images')
    
    // 调用 nano_banana 生成图片，直接传递环境变量
    const command = `python3 ~/.config/pie/skills/nano_banana/scripts/image_gen.py generate --prompt "${prompt.replace(/"/g, '\\"')}" --output "${path.join(outputDir, outputName)}"`
    
    execSync(command, { 
      stdio: 'pipe',
      env: {
        ...process.env,
        PIE_TOKEN: process.env.PIE_TOKEN,
        PIE_BASE_URL: process.env.PIE_BASE_URL || 'https://pie-gateway.weapp.me'
      }
    })
    
    // 查找生成的文件
    const files = fs.readdirSync(outputDir)
    const generatedFile = files.find(f => f.startsWith(outputName))
    
    if (!generatedFile) {
      throw new Error('图片生成失败')
    }
    
    res.json({
      success: true,
      imagePath: `/outputs/images/${generatedFile}`,
      fullPath: path.join(outputDir, generatedFile)
    })
  } catch (error) {
    console.error('Generate Cover Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// API: 生成视频
app.post('/api/generate-video', (req, res) => {
  const { 
    audioPath, 
    imagePath, 
    srtPath, 
    withSubtitles, 
    originalFilename, 
    aspectRatio = '9:16',
    subtitleStyle = {}
  } = req.body
  
  // CSS颜色转ASS颜色格式 (#RRGGBB -> &H00BBGGRR)
  function cssToAssColor(cssColor) {
    if (cssColor.startsWith('&H')) return cssColor
    const hex = cssColor.replace('#', '')
    const r = hex.substring(0, 2)
    const g = hex.substring(2, 4)
    const b = hex.substring(4, 6)
    return `&H00${b}${g}${r}`.toUpperCase()
  }
  
  const fontSize = subtitleStyle.fontSize || '24'
  const fontColor = cssToAssColor(subtitleStyle.fontColor || '#FFFFFF')
  const outlineColor = cssToAssColor(subtitleStyle.outlineColor || '#000000')
  const outlineWidth = subtitleStyle.outlineWidth || '2'
  
  try {
    const audioFullPath = path.join(__dirname, audioPath)
    const imageFullPath = path.join(__dirname, imagePath)
    
    const baseName = originalFilename 
      ? path.basename(originalFilename, path.extname(originalFilename))
      : `video-${Date.now()}`
    const outputName = `pimsleur 日常英语对话-${baseName}.mp4`
    const outputPath = path.join(__dirname, 'outputs', 'videos', outputName)
    
    const videoSize = aspectRatio === '9:16' ? '1080:1920' : '1920:1080'
    const marginV = aspectRatio === '9:16' ? 60 : 40
    
    let command
    
    if (withSubtitles && srtPath) {
      const srtFullPath = path.join(__dirname, srtPath)
      const styleStr = `FontName=PingFang SC,FontSize=${fontSize},PrimaryColour=${fontColor},OutlineColour=${outlineColor},Outline=${outlineWidth},Shadow=0,Alignment=2,MarginV=${marginV}`
      command = `ffmpeg -loop 1 -i "${imageFullPath}" -i "${audioFullPath}" -vf "scale=${videoSize}:force_original_aspect_ratio=decrease,pad=${videoSize}:(ow-iw)/2:(oh-ih)/2,subtitles='${srtFullPath}':force_style='${styleStr}'" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -y "${outputPath}"`
    } else {
      command = `ffmpeg -loop 1 -i "${imageFullPath}" -i "${audioFullPath}" -vf "scale=${videoSize}:force_original_aspect_ratio=decrease,pad=${videoSize}:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest -y "${outputPath}"`
    }
    
    execSync(command, { stdio: 'pipe' })
    
    res.json({
      success: true,
      videoPath: `/outputs/videos/${encodeURIComponent(outputName)}`,
      downloadFilename: outputName,
      fullPath: outputPath
    })
  } catch (error) {
    console.error('Generate Video Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// API: 上传裁剪后的图片
app.post('/api/upload-cover', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '没有上传图片' })
  }
  
  const outputDir = path.join(__dirname, 'outputs', 'images')
  const outputName = `cover-${Date.now()}.jpg`
  const outputPath = path.join(outputDir, outputName)
  
  fs.renameSync(req.file.path, outputPath)
  
  res.json({
    success: true,
    imagePath: `/outputs/images/${outputName}`,
    fullPath: outputPath
  })
})

// API: 字幕文本强制对齐 (Forced Alignment)
app.post('/api/align-subtitle', async (req, res) => {
  const { audioPath, subtitleText } = req.body
  
  try {
    const fullPath = path.join(__dirname, audioPath)
    
    if (!fs.existsSync(fullPath)) {
      return res.status(400).json({ error: '音频文件不存在' })
    }
    
    const lines = subtitleText.split('\n').filter(line => line.trim())
    if (lines.length === 0) {
      return res.status(400).json({ error: '字幕文本为空' })
    }
    
    // 获取音频时长
    const durationResult = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${fullPath}"`)
    const durationSec = parseFloat(durationResult.toString().trim())
    const durationMs = durationSec * 1000
    
    // 均匀分配时间（作为 fallback，后续可以替换为真正的 forced alignment）
    const avgDuration = durationMs / lines.length
    
    const utterances = lines.map((text, index) => ({
      start_time: Math.floor(index * avgDuration),
      end_time: Math.floor((index + 1) * avgDuration),
      text: text.trim()
    }))
    
    // 生成 SRT 字幕
    const srtContent = generateSRT(utterances)
    const srtFilename = path.basename(audioPath, path.extname(audioPath)) + '-manual.srt'
    const srtPath = path.join(__dirname, 'outputs', srtFilename)
    fs.writeFileSync(srtPath, srtContent)
    
    res.json({
      success: true,
      srtPath: `/outputs/${srtFilename}`,
      duration: durationMs,
      lineCount: lines.length
    })
  } catch (error) {
    console.error('Align Subtitle Error:', error)
    res.status(500).json({ error: error.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`)
})
