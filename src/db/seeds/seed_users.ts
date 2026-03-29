import { Knex } from "knex";
import { faker } from "@faker-js/faker";

export async function seed(knex: Knex): Promise<void> {
   await knex("order_items").del();
   await knex("orders").del();
   await knex("products").del();
   await knex("users").del();

   const users = Array.from({ length: 100_000 }, (_, i) => ({
      name: faker.person.fullName(),
      email: `user_${i}_${faker.internet.email()}`,
      password: faker.internet.password(),
      country: faker.location.countryCode("alpha-2"),
      active: faker.datatype.boolean(),
   }));

   const chunkSize = 5_000;
   for (let i = 0; i < users.length; i += chunkSize) {
      await knex("users").insert(users.slice(i, i + chunkSize));
   }

   const products = Array.from({ length: 1_000 }, () => ({
      name: faker.commerce.productName(),
      category: faker.commerce.department(),
      price: faker.commerce.price({ min: 10, max: 500 }),
      stock: faker.number.int({ min: 0, max: 200 }),
   }));

   await knex("products").insert(products);

   const allUserIds = await knex("users").pluck("id");
   const allProductIds = await knex("products").pluck("id");

   const orders = Array.from({ length: 50_000 }, () => ({
      user_id: faker.helpers.arrayElement(allUserIds),
      total: faker.commerce.price({ min: 20, max: 2000 }),
      status: faker.helpers.arrayElement(["pending", "completed", "cancelled"]),
      ordered_at: faker.date.past({ years: 2 }),
   }));

   for (let i = 0; i < orders.length; i += chunkSize) {
      await knex("orders").insert(orders.slice(i, i + chunkSize));
   }

   const allOrderIds = await knex("orders").pluck("id");

   const items = Array.from({ length: 150_000 }, () => ({
      order_id: faker.helpers.arrayElement(allOrderIds),
      product_id: faker.helpers.arrayElement(allProductIds),
      quantity: faker.number.int({ min: 1, max: 10 }),
      unit_price: faker.commerce.price({ min: 10, max: 500 }),
   }));

   for (let i = 0; i < items.length; i += chunkSize) {
      await knex("order_items").insert(items.slice(i, i + chunkSize));
   }
}
