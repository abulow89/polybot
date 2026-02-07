import axios, { AxiosError } from 'axios';

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

interface FetchOptions {
  retries?: number;
  retryDelay?: number;
  timeout?: number;
}

const fetchData = async (
  url: string,
  options: FetchOptions = {}
): Promise<any> => {
  const {
    retries = 3,
    retryDelay = 1000,
    timeout = 10000
  } = options;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await axios.get(url, { timeout });
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      
      // Determine if error is retryable
      const isServerError = status && status >= 500; // 500, 502, 503, etc.
      const isTimeout = axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT';
      const isNetworkError = axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ENOTFOUND';
      const isRetryable = isServerError || isTimeout || isNetworkError;
      
      // If this is the last attempt or error is not retryable, throw
      if (!isRetryable || attempt === retries - 1) {
        console.error(`[FETCH ERROR] Failed to fetch ${url}:`, {
          status,
          code: axiosError.code,
          message: axiosError.message
        });
        throw error;
      }
      
      // Calculate backoff with exponential delay
      const backoff = retryDelay * Math.pow(2, attempt);
      
      console.log(
        `[FETCH RETRY] Attempt ${attempt + 1}/${retries} failed for ${url} ` +
        `(${status || axiosError.code}). Retrying in ${backoff}ms...`
      );
      
      await sleep(backoff);
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw new Error('Unexpected error in fetchData');
};

export default fetchData;
