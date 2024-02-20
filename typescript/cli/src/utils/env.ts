import z from 'zod';

const envScheme = z.object({
  HYP_KEY: z.string().optional(),
});

export const ENV = envScheme.parse(process.env);
