import { GoogleGenAI, Type } from "@google/genai";
// FIX: Import necessary types and prompt factory functions
import type { FormState, QuestionPaper, Question } from '../types';
import { createGenerationPrompt, createRegenerationPrompt } from '../utils/promptFactory';

if (!process.env.API_KEY) {
  throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Models tried in order. Gemini often returns 503 "high demand" or 429 for a
// busy model, so retry briefly, then fall back to the next model.
const MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"];
const RETRIES_PER_MODEL = 2;

const isRetryable = (error: unknown) =>
    /\b(429|500|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|fetch failed|network/i
        .test(error instanceof Error ? error.message : String(error));

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type GenerateParams = Parameters<typeof ai.models.generateContent>[0];

const generateWithFallback = async (params: Omit<GenerateParams, 'model'>) => {
    let lastError: unknown;
    for (const model of MODELS) {
        for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
            try {
                return await ai.models.generateContent({ ...params, model });
            } catch (error) {
                lastError = error;
                console.warn(`Gemini ${model} attempt ${attempt + 1} failed:`, error);
                if (!isRetryable(error)) throw error;
                if (attempt < RETRIES_PER_MODEL) await sleep(1000 * 2 ** attempt);
            }
        }
    }
    throw lastError;
};

const describeApiError = (error: unknown): string | null => {
    const message = error instanceof Error ? error.message : String(error);
    if (/API_KEY_INVALID|API key not valid|PERMISSION_DENIED|\b(401|403)\b/i.test(message)) {
        return "The Gemini API key is invalid or not allowed. Check VITE_API_KEY.";
    }
    if (/RESOURCE_EXHAUSTED|\b429\b/i.test(message)) {
        return "Gemini API quota exceeded. Please wait a minute and try again.";
    }
    if (isRetryable(error)) {
        return "Gemini servers are busy right now. Please try again in a moment.";
    }
    return null;
};

// FIX: Update schema to include new question properties for richer content generation.
const questionItemSchema = {
    type: Type.OBJECT,
    properties: {
        question_text: { type: Type.STRING },
        options: { 
            type: Type.ARRAY,
            description: "Array of 4 option strings for MCQs. Omit for other question types.",
            items: { type: Type.STRING } 
        },
        correct_answer: { type: Type.STRING, description: "The correct answer. For MCQs, it should match one of the options exactly." },
        marks: { type: Type.INTEGER },
        chapter: { type: Type.STRING, description: "The source chapter name from the provided list." },
        diagram_svg: { type: Type.STRING, description: "A valid SVG string for diagram-based questions (e.g., Geometry, Pie Charts). Ensure labels do not overlap lines." },
        match_a: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Column A for 'Match the Following' questions." },
        match_b: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Column B for 'Match the Following' questions." },
    },
    required: ["question_text", "correct_answer", "marks", "chapter"]
};

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    institution_name: { type: Type.STRING, description: "The name of the institution, e.g., 'GSEB Academy'."},
    title: { type: Type.STRING, description: "A suitable title for the question paper, e.g., 'Annual Examination'."},
    grade: { type: Type.STRING, description: "The grade or class for which the paper is intended, e.g., 'Class 10'."},
    medium: { type: Type.STRING, description: "The medium of instruction, e.g., 'English Medium'."},
    subject: { type: Type.STRING, description: "The subject of the question paper."},
    difficulty: { type: Type.STRING, description: "The difficulty level of the paper, e.g., 'Medium'."},
    total_marks: { type: Type.INTEGER, description: "The total marks for the paper."},
    duration_minutes: { type: Type.INTEGER, description: "The recommended duration in minutes, e.g., 180 for 3 hours."},
    sections: {
      type: Type.ARRAY,
      description: "An array of question sections (e.g., MCQs, Short Answers, Long Answers).",
      items: {
        type: Type.OBJECT,
        properties: {
          section_title: { type: Type.STRING, description: "Title of the section, e.g., 'Section A: Multiple Choice Questions'."},
          questions: {
            type: Type.ARRAY,
            description: "An array of questions within this section.",
            items: questionItemSchema
          }
        },
        required: ["section_title", "questions"]
      }
    }
  },
  required: ["institution_name", "title", "grade", "medium", "subject", "difficulty", "total_marks", "duration_minutes", "sections"]
};


export const generateQuestionPaper = async (formData: FormState): Promise<QuestionPaper> => {
  // FIX: Use the prompt factory to generate a more detailed and structured prompt.
  const prompt = createGenerationPrompt(formData);

  try {
    const response = await generateWithFallback({
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.7,
        }
    });
    
    const jsonText = (response.text ?? '').trim();
    if (!jsonText.startsWith('{') || !jsonText.endsWith('}')) {
        console.error("Received non-JSON response:", jsonText);
        throw new Error("The model returned a non-JSON response. Please try again.");
    }
    const parsedPaper: QuestionPaper = JSON.parse(jsonText);

    // FIX: Add unique IDs to each question after generation for state management.
    parsedPaper.sections.forEach(section => {
        section.questions.forEach(question => {
            (question as Question).id = crypto.randomUUID();
        });
    });

    return parsedPaper;

  } catch (error) {
    console.error("Error generating question paper:", error);
    if (error instanceof Error && error.message.includes('SAFETY')) {
        throw new Error("The generation was blocked due to safety policies. Please try a different prompt.");
    }
    const apiMessage = describeApiError(error);
    if (apiMessage) throw new Error(apiMessage);
    if (error instanceof SyntaxError) {
        throw new Error("Failed to parse the question paper from the model. The response was not valid JSON.");
    }
    throw new Error("Failed to generate question paper. The model may have returned an invalid format or an error occurred.");
  }
};

// FIX: Add the missing `regenerateQuestion` function to allow regenerating individual questions.
export const regenerateQuestion = async (
    questionToReplace: Question,
    paperContext: Pick<QuestionPaper, 'grade' | 'medium' | 'subject' | 'difficulty'>,
    chapters: string[]
): Promise<Omit<Question, 'id'>> => {
    const prompt = createRegenerationPrompt(questionToReplace, paperContext, chapters);

    try {
        const response = await generateWithFallback({
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: questionItemSchema,
                temperature: 0.8, // Slightly higher temperature for more variety
            }
        });

        const jsonText = (response.text ?? '').trim();
        if (!jsonText.startsWith('{') || !jsonText.endsWith('}')) {
            console.error("Received non-JSON response for regeneration:", jsonText);
            throw new Error("The model returned a non-JSON response for the new question.");
        }
        
        return JSON.parse(jsonText);
    } catch (error) {
        console.error("Error regenerating question:", error);
        if (error instanceof Error && error.message.includes('SAFETY')) {
            throw new Error("The regeneration was blocked due to safety policies.");
        }
        const apiMessage = describeApiError(error);
        if (apiMessage) throw new Error(apiMessage);
        if (error instanceof SyntaxError) {
            throw new Error("Failed to parse the new question from the model.");
        }
        throw new Error("Failed to regenerate the question.");
    }
};