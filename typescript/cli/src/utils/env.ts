import z from 'zod';

const envScheme = z.object({
  HYP_KEY: z.string().optional(),
});

const parsedEnv = envScheme.safeParse(process.env);

if (!parsedEnv.success)
  throw new Error(
    `Failed to parse environment variables: ${JSON.stringify(
      parsedEnv.error.format(),
      null,
    )}`,
  );

export const ENV = parsedEnv.data;
