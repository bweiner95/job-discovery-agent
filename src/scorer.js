import Anthropic from '@anthropic-ai/sdk';
import { CANDIDATE_PROFILE, SCORING_RUBRIC } from './candidate-profile.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BATCH_SIZE = 5;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildPrompt(batch) {
  const jobList = batch
    .map(
      (job, i) => `
JOB ${i + 1}
Title:       ${job.title}
Company:     ${job.company}
Location:    ${job.location}
Salary:      ${job.salary || 'Not listed'}
Description: ${(job.description || '').slice(0, 800).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}
`.trim(),
    )
    .join('\n\n---\n\n');

  return `${CANDIDATE_PROFILE}\n\n${SCORING_RUBRIC}\n\nScore each of the following ${batch.length} job(s). Return ONLY a JSON array — no prose, no markdown fences — using this exact shape:\n[{"score": <1-10>, "reason": "<1-2 sentences explaining the score, calling out 1-2 specific signals from the job that drove it>"}, ...]\n\nJOBS TO SCORE:\n${jobList}`;
}

export async function scoreJobs(jobs) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY not set — assigning default scores');
    return jobs.map((j) => ({ ...j, score: 5, score_reason: 'Scoring unavailable' }));
  }

  const scored = [];

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);

    let attempts = 0;
    while (attempts < 3) {
      try {
        const msg = await client.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          messages:   [{ role: 'user', content: buildPrompt(batch) }],
        });

        const text = msg.content[0]?.text || '[]';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error('No JSON array in response');

        const scores = JSON.parse(jsonMatch[0]);

        for (let j = 0; j < batch.length; j++) {
          scored.push({
            ...batch[j],
            score:        Number(scores[j]?.score) || 5,
            score_reason: scores[j]?.reason || '',
          });
        }
        break;
      } catch (err) {
        attempts++;
        if (err.status === 429 || err.message?.includes('overloaded')) {
          console.warn(`Scoring rate limit — retrying in ${attempts * 10} s…`);
          await sleep(attempts * 10_000);
        } else if (attempts >= 3) {
          console.error('Scoring failed after 3 attempts:', err.message);
          for (const job of batch) {
            scored.push({ ...job, score: 5, score_reason: 'Scoring error' });
          }
        } else {
          await sleep(2_000);
        }
      }
    }

    if (i + BATCH_SIZE < jobs.length) await sleep(1_500);
  }

  return scored;
}
