const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge-base');
const NOT_FOUND = '知识库中暂时没有找到相关答案，建议转人工客服处理。';

// 让 Express 能读取请求中的 JSON，例如 { "question": "营业时间是什么？" }。
app.use(express.json());

// 每条知识用空行分隔；第一行是关键词，第二行是回答内容。
function parseKnowledge(text, matchedFile) {
  return text.split(/\r?\n\s*\r?\n/).map((block) => {
    const keywordLine = block.match(/^关键词：(.+)$/m);
    const contentLine = block.match(/^内容：(.+)$/m);
    if (!keywordLine || !contentLine) return null;

    return {
      keywords: keywordLine[1].split('，').map((word) => word.trim()).filter(Boolean),
      content: contentLine[1].trim(),
      matchedFile
    };
  }).filter(Boolean);
}

// 忽略空格和常见标点，让“付款后，多久开通？”也能匹配“付款后多久开通”。
function normalize(text) {
  return text.toLowerCase().replace(/[\s，。！？、；：,.!?;:]/g, '');
}

// 提问和统计共用同一套读取方式，保证统计数量与实际可检索条目一致。
async function loadKnowledgeFiles() {
  const files = await fs.readdir(KNOWLEDGE_DIR, { withFileTypes: true });
  const fileNames = files
    .filter((file) => file.isFile() && file.name.toLowerCase().endsWith('.txt'))
    .map((file) => file.name)
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(fileNames.map(async (fileName) => {
    const text = await fs.readFile(path.join(KNOWLEDGE_DIR, fileName), 'utf8');
    return { fileName, entries: parseKnowledge(text, fileName) };
  }));
}

// 查看当前知识库规模：每次请求重新读取文件，统计会随内容更新。
app.get('/stats', async (req, res) => {
  try {
    const knowledgeFiles = await loadKnowledgeFiles();
    const files = knowledgeFiles.map((file) => ({
      fileName: file.fileName,
      entryCount: file.entries.length
    }));
    return res.json({
      fileCount: files.length,
      totalEntries: files.reduce((total, file) => total + file.entryCount, 0),
      files
    });
  } catch (error) {
    console.error('统计知识库失败：', error);
    return res.status(500).json({ error: '统计知识库失败，请稍后重试。' });
  }
});

app.post('/ask', async (req, res) => {
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: '请提供非空的 question 字符串。' });
  }

  try {
    // 每次提问都读取目录中的 txt 文件，新增或修改知识文件后无需重启服务。
    const knowledgeFiles = await loadKnowledgeFiles();
    const entries = knowledgeFiles.flatMap((file) => file.entries);
    const normalizedQuestion = normalize(question.trim());

    // 教学用的简单检索：找到问题中包含的最长关键词。
    // 较长的词通常更具体，例如“退款时间”优先于“退款”。
    let bestMatch = null;
    let longestKeyword = 0;
    for (const entry of entries) {
      for (const keyword of entry.keywords) {
        if (normalizedQuestion.includes(normalize(keyword)) && keyword.length > longestKeyword) {
          bestMatch = entry;
          longestKeyword = keyword.length;
        }
      }
    }

    // 回答直接来自检索到的知识条目；这里没有调用 AI 模型。
    return res.json({
      answer: bestMatch ? bestMatch.content : NOT_FOUND,
      matchedFile: bestMatch ? bestMatch.matchedFile : null
    });
  } catch (error) {
    console.error('读取知识库失败：', error);
    return res.status(500).json({ error: '读取知识库失败，请稍后重试。' });
  }
});

app.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});
