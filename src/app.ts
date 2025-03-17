import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import dotenv from "dotenv";

const DocumentIntelligence =
    require("@azure-rest/ai-document-intelligence").default,
  {
    getLongRunningPoller,
    isUnexpected,
  } = require("@azure-rest/ai-document-intelligence");

dotenv.config();

const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;

if (!endpoint || !key) {
  throw new Error(
    "Missing required environment variables. Please check your .env file."
  );
}

interface ParsedQuestionData {
  question: string | undefined;
  answers: string[];
  correctIndex: number;
}

async function main() {
  const distFolder = path.join(__dirname, "../parsed");
  if (!fs.existsSync(distFolder)) {
    fs.mkdirSync(distFolder, { recursive: true });
  }

  const client = DocumentIntelligence(endpoint, { key: key });
  for (let i = 27; i <= 310; i++) {
    const srcJsonPath = path.join(__dirname, "../scraped", `${i}.json`);
    const distJsonPath = path.join(distFolder, `${i}.json`);

    try {
      // Check if file exists and read it
      if (fs.existsSync(srcJsonPath)) {
        const data = JSON.parse(
          fs.readFileSync(srcJsonPath, "utf8")
        ) as ParsedQuestionData;

        // Only extract text if question is undefined or missing
        if (!data.question) {
          console.log(`Extracting text for question ${i}...`);
          data.question = await extractText(i);
          // Add one second delay after extracting text
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          console.log(`Question ${i} already has text.`);
        }
        fs.writeFileSync(distJsonPath, JSON.stringify(data, null, 2));
        console.log(`Saved question ${i} with extracted text.`);
      } else {
        console.log(`JSON file for question ${i} not found.`);
      }
    } catch (error) {
      console.error(`Error processing question ${i}:`, error);
    }
  }

  async function extractText(i: number): Promise<string> {
    const formUrl = `https://raw.githubusercontent.com/BogdanYarotsky/german-test-scraper/refs/heads/main/padded/${i}.png`;
    const response = await client
      .path("/documentModels/{modelId}:analyze", "prebuilt-read")
      .post({
        contentType: "application/json",
        body: {
          urlSource: formUrl,
        },
      });

    if (isUnexpected(response)) {
      throw response.body.error;
    }
    const poller = getLongRunningPoller(client, response);
    const analyzeResult = (await poller.pollUntilDone()).body.analyzeResult;
    const content = analyzeResult?.content as string;
    return content.split("\n")[0];
  }
}

// Configuration
const MIN_HEIGHT = 50;
const INPUT_FOLDER = "./scraped"; // Change this to your PNG folder path
const OUTPUT_FOLDER = "./padded"; // Where to save the processed images
if (!fs.existsSync(OUTPUT_FOLDER)) {
  fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });
}
// Function to check if files are in sequence from 1 to 310
async function pad() {
  try {
    // Get all PNG files from the input folder
    const files = fs
      .readdirSync(INPUT_FOLDER)
      .filter((file) => file.toLowerCase().endsWith(".png"));

    console.log(`Found ${files.length} PNG files to process.`);

    // Process each file
    for (const file of files) {
      const inputPath = path.join(INPUT_FOLDER, file);
      const outputPath = path.join(OUTPUT_FOLDER, file);

      // Get image metadata
      const metadata = await sharp(inputPath).metadata();

      if (!metadata.height) {
        console.log(`Error: Could not read metadata for ${file}`);
        continue;
      }

      // Only add padding if height is less than minimum
      if (metadata.height < MIN_HEIGHT) {
        // Calculate padding needed
        const paddingNeeded = MIN_HEIGHT - metadata.height;
        const topPadding = Math.floor(paddingNeeded / 2);
        const bottomPadding = paddingNeeded - topPadding;

        console.log(
          `Processing ${file}: Adding ${paddingNeeded}px padding (${topPadding}px top, ${bottomPadding}px bottom)`
        );

        // Extend image with padding (transparent background)
        await sharp(inputPath)
          .extend({
            top: topPadding,
            bottom: bottomPadding,
            left: 0,
            right: 0,
            background: { r: 0, g: 0, b: 0, alpha: 0 }, // Transparent
          })
          .toFile(outputPath);
      } else {
        // Just copy the file if it already meets requirements
        console.log(
          `${file} already meets minimum height (${metadata.height}px)`
        );
        fs.copyFileSync(inputPath, outputPath);
      }
    }

    console.log("All images processed successfully!");
  } catch (error) {
    console.error("Error processing images:", error);
  }
}

async function run() {
  // Launch the browser

  const browser = await puppeteer.launch({
    headless: false, // Use non-headless mode
  });

  try {
    const page = await browser.newPage();
    const url = "https://oet.bamf.de/ords/oetut/f?p=514:1::::::"; // Replace with your target URL
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.waitForSelector("#P1_BUL_ID");
    await page.select("#P1_BUL_ID", "9");
    console.log("Selected option with value 9 from the dropdown");
    await page.waitForSelector('input[value="Zum Fragenkatalog"]');
    await page.click('input[value="Zum Fragenkatalog"]');
    console.log("Clicked on 'Zum Fragenkatalog' button");
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    const dirPath = path.join(__dirname, "../scraped");
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    let count = 0;
    while (count < 320) {
      count++;
      console.log(`Processing question ${count}...`);

      // Find all answers in the table
      const answers = await page.$$eval('.t3data[headers="ANTWORT"]', (cells) =>
        cells.map((cell) => cell.textContent?.trim() || "")
      );

      // Find the correct answer index (looking for the row with name="FARBE" attribute)
      const correctIndex = await page.$$eval(
        '.t3data[headers="RICHTIGE_ANTWORT"]',
        (cells) => {
          for (let i = 0; i < cells.length; i++) {
            if (cells[i].getAttribute("name") === "FARBE") {
              return i;
            }
          }
          return -1;
        }
      );

      // Save the question data to a JSON file
      const questionData = {
        answers,
        correctIndex,
      };

      const jsonPath = path.join(dirPath, `${count}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(questionData, null, 2));
      console.log(`Question data saved to ${jsonPath}`);

      // Find the image element inside the specific span
      const imgElement = await page.$("#P30_AUFGABENSTELLUNG_BILD > img");
      if (imgElement) {
        console.log("Found the image element, attempting to save it...");
        const imageSrc = await imgElement.evaluate((img) => img.src);
        const response = await fetch(imageSrc);
        const buffer = await response.arrayBuffer();
        const imagePath = path.join(dirPath, `${count}.png`);
        fs.writeFileSync(imagePath, Buffer.from(buffer));
        console.log(`Image saved to ${imagePath}`);
      } else {
        console.log("Image element not found");
      }

      // Find and click the next task button if it exists
      const nextButton = await page.$('input[name="GET_NEXT_ID"]');
      if (nextButton) {
        console.log("Found 'nächste Aufgabe' button, clicking it...");
        await nextButton.click();
        await page.waitForNavigation({ waitUntil: "networkidle2" });
      } else {
        console.log("Next task button not found. Exiting the loop.");
        break;
      }
    }
  } catch (error) {
    console.error("An error occurred:", error);
  } finally {
    // Close the browser
    await browser.close();
    console.log("Browser closed");
  }
}

// Run the function
main().catch(console.error);
