import mongoose from 'mongoose';

let isConnected = false;

export async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/floodscope';

  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    isConnected = true;
    console.log('  ✅ MongoDB connected:', mongoose.connection.name);
  } catch (err) {
    console.error('  ❌ MongoDB connection failed:', err.message);
    console.error('     Set MONGODB_URI in .env file');
    throw err;
  }
}

export { mongoose };
