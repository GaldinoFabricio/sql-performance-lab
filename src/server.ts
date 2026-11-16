import app from "./app";

const PORT = process.env.PORT || 3000;

app.listen(PORT, (err?: Error) => {
  if (err) {
    console.error(`Falha ao subir na porta ${PORT}:`, err);
    process.exit(1);
  }
  console.log(`Running on http://localhost:${PORT}`);
});
