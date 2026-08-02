// server.js
// Servidor Editor Titã - processa vídeos com FFmpeg (marca d'água + vídeo centralizado)
// Este servidor roda FORA da Lovable, num serviço separado (ex: Render.com)
// Ele NÃO fala com o Supabase/Lovable Cloud diretamente: só recebe a URL do
// vídeo de entrada e DEVOLVE o vídeo final pronto na própria resposta HTTP.
// Quem salva o arquivo final é a Edge Function da Lovable, que já tem acesso
// ao armazenamento do projeto.

import express from "express";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// A marca d'água fica junto do código do servidor (sobe pro GitHub com ele)
const WATERMARK_PATH = path.join(__dirname, "assets", "watermark.png");

const app = express();
app.use(express.json());

const SERVER_SECRET = process.env.SERVER_SECRET; // senha simples pra proteger o endpoint

if (!SERVER_SECRET) {
  console.warn("[AVISO] Configure a variável de ambiente SERVER_SECRET.");
}

// ==== FUNÇÃO: baixa um arquivo de uma URL direto pro disco (sem carregar
// tudo na memória de uma vez - importante no plano grátis, que tem 512MB) ====
async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar arquivo: ${url} (status ${res.status})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

// ==== FUNÇÃO: roda o comando FFmpeg ====
function runFFmpeg(watermarkPath, videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-loop", "1",
      "-i", watermarkPath,
      "-i", videoPath,
      "-filter_complex",
      "[0:v]scale=1080:1920,setsar=1[bg];[1:v]scale=810:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[outv]",
      "-map", "[outv]",
      "-map", "1:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-threads", "1",
      "-c:a", "aac",
      "-shortest",
      outputPath,
    ];

    const proc = spawn(ffmpegPath, args);

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg saiu com código ${code}. Log:\n${stderr.slice(-2000)}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

// ==== ENDPOINT PRINCIPAL ====
// Recebe { videoUrl }, devolve o VÍDEO FINAL diretamente no corpo da resposta
// (Content-Type: video/mp4), pronto pra Lovable salvar onde quiser.
app.post("/process", async (req, res) => {
  const authHeader = req.headers["x-server-secret"];
  if (authHeader !== SERVER_SECRET) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  const { videoUrl } = req.body;
  if (!videoUrl) {
    return res.status(400).json({ error: "Campo 'videoUrl' é obrigatório" });
  }

  if (!fs.existsSync(WATERMARK_PATH)) {
    return res.status(500).json({
      error: "Marca d'água não encontrada no servidor. Confira se assets/watermark.png foi enviado ao repositório.",
    });
  }

  const id = randomUUID();
  const videoPath = path.join(TMP_DIR, `input-${id}.mp4`);
  const outputPath = path.join(TMP_DIR, `output-${id}.mp4`);

  try {
    console.log(`[${id}] Baixando vídeo original...`);
    await downloadFile(videoUrl, videoPath);

    console.log(`[${id}] Rodando FFmpeg...`);
    await runFFmpeg(WATERMARK_PATH, videoPath, outputPath);

    console.log(`[${id}] Enviando vídeo final na resposta...`);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("X-Job-Id", id);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    stream.on("close", () => {
      [videoPath, outputPath].forEach((p) => {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });
    });
  } catch (err) {
    console.error(`[${id}] Erro:`, err.message);
    [videoPath, outputPath].forEach((p) => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    res.status(500).json({ success: false, jobId: id, error: err.message });
  }
});

// Endpoint simples de teste, pra saber se o servidor está de pé
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Editor Titã rodando na porta ${PORT}`);
});
