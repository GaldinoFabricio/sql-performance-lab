import app from "./app";

const PORT = process.env.PORT || 3000;

app.listen(PORT, (err?: Error) => {
   if (err) {
      console.error(`Failed to start on port ${PORT}:`, err);
      process.exit(1);
   }
   console.log(`Running on http://localhost:${PORT}`);
});
